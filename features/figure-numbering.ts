import { App, TFile, MarkdownPostProcessorContext, MarkdownRenderChild } from 'obsidian';
import { BaseFeature, FeatureSettings } from './base-feature';

// Utility function to detect PDF export context
function isPdfExport(el: HTMLElement): boolean {
	// Check various indicators that we're in a PDF export context
	return !!(
		el.closest('.print') ||
		el.closest('.pdf-export') ||
		document.body.classList.contains('print') ||
		document.body.classList.contains('pdf-export') ||
		window.location.href.includes('print-preview') ||
		// Check if this is a print media query context
		window.matchMedia && window.matchMedia('print').matches
	);
}

interface FigureInfo {
	number: string;
	id: string;
	imagePath: string;
}

interface FigureNumberingSettings extends FeatureSettings {
	enableFigureNumbering: boolean;
}

const FIGURE_TEXT = {
	english: "Figure",
	hebrew: "איור"
};

export class FigureNumberingFeature extends BaseFeature {
	private app: App;
	// Store figure information per file
	private figuresByFile: Map<string, FigureInfo[]> = new Map();
	// Track which figures have been assigned per file
	private assignedFigures: Map<string, Set<string>> = new Map();
	// Track processed elements to prevent duplicates
	private processedElements: WeakSet<HTMLElement> = new WeakSet();
	// Processing lock to prevent race conditions
	private processingLock: Map<string, boolean> = new Map();

	constructor(app: App, debugMode: boolean = false) {
		super(debugMode);
		this.app = app;
	}

	getName(): string {
		return 'FigureNumbering';
	}

	isEnabled(settings: FigureNumberingSettings): boolean {
		return settings.enableFigureNumbering;
	}

	async process(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
		// Special handling for PDF export
		if (isPdfExport(el)) {
			await this.preprocessForPdfExport(el, ctx);
			return;
		}

		// Use MarkdownRenderChild for persistent, event-driven processing
		
		// Process figure captions (blockquotes)
		const blockquotes = el.querySelectorAll('blockquote');
		blockquotes.forEach(blockquote => {
			ctx.addChild(new FigureCaptionRenderer(blockquote as HTMLElement, this.app, ctx, this));
		});

		// Process figure references (links)
		const figureLinks = el.querySelectorAll('a[href*="#^figure"]');
		figureLinks.forEach(link => {
			ctx.addChild(new FigureReferenceRenderer(link as HTMLElement, this.app, ctx, this));
		});

		// Process embedded figures (images with figure IDs)
		const images = el.querySelectorAll('img[src], embed[src*=".pdf"]');
		images.forEach(img => {
			// Check if this image has a figure ID in nearby text
			const parent = img.closest('p, div, span');
			if (parent && parent.textContent?.includes('^figure')) {
				ctx.addChild(new FigureImageRenderer(img as HTMLElement, this.app, ctx, this));
			}
		});
	}

	onFileOpen(filePath: string): void {
		this.clearCacheForFile(filePath);
		const file = this.app.vault.getFileByPath(filePath);
		if (file) {
			this.scanForFigures(file);
		}
	}

	onLayoutChange(): void {
		// Only trigger a delayed re-scan if we're in reading view and have no figures cached
		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile && !this.figuresByFile.has(activeFile.path)) {
			setTimeout(() => {
				this.scanForFigures(activeFile);
			}, 500);
		}
	}

	cleanup(): void {
		this.resetAllCaches();
	}

	// Extract file prefix for figure numbering (e.g., "SLD1_002" -> "2", "IRB1_HW003" -> "HW3")
	private getFilePrefix(fileName: string): string {
		const prefixMatch = fileName.match(/[A-Z]+\d+_([A-Z]*\d+)/i);
		if (prefixMatch && prefixMatch[1]) {
			// Remove leading zeros from numbers while preserving letters
			const prefix = prefixMatch[1].replace(/(\D*)0*(\d+)/, '$1$2');
			return prefix || '1';
		}
		return '1';
	}

	// Detect if content is Hebrew based on first heading
	private isHebrewContent(content: string): boolean {
		const headingMatch = content.match(/^#+\s+(.+)$/m);
		if (headingMatch && headingMatch[1]) {
			const firstChar = headingMatch[1].trim().charAt(0);
			return /[\u0590-\u05FF]/.test(firstChar);
		}
		return false;
	}

	// Scan document for figures and create numbering
	private async scanForFigures(file: TFile): Promise<void> {
		try {
			const content = await this.app.vault.read(file);
			const isHebrew = this.isHebrewContent(content);
			const prefix = this.getFilePrefix(file.basename);
			const figureText = isHebrew ? FIGURE_TEXT.hebrew : FIGURE_TEXT.english;

			// Find all figure references: ![[image.ext]]^figureID (now includes PDF)
			// Updated regex to handle more edge cases including dashes and line endings
			const figureRegex = /!\[\[([^\]]+\.(png|jpg|jpeg|gif|bmp|svg|webp|pdf)[^\]]*)\]\]\^figure([^\s\r\n]*)/gi;
			const figures: FigureInfo[] = [];
			let match;
			let counter = 1;

			this.log(`Scanning for figures in file: ${file.path}`);
			this.log(`Content length: ${content.length} characters`);

			while ((match = figureRegex.exec(content)) !== null) {
				const imagePath = match[1].trim();
				const figureId = match[3] || '';
				const figureNumber = `${figureText} ${prefix}.${counter}`;

				this.log(`Regex match ${counter}: Full match="${match[0]}", Image="${imagePath}", ID="${figureId}"`);

				figures.push({
					number: figureNumber,
					id: figureId,
					imagePath: imagePath
				});

				this.log(`Found figure: ${imagePath} -> ${figureNumber} (ID: ${figureId})`);

				counter++;
			}

			this.log(`Total figures found: ${figures.length}`);

			// Fallback search: look for any ^figure patterns that might have been missed
			const fallbackRegex = /\^figure[^\s\r\n]*/gi;
			const fallbackMatches = content.match(fallbackRegex) || [];
			if (fallbackMatches.length !== figures.length) {
				this.log(`WARNING: Fallback search found ${fallbackMatches.length} ^figure patterns, but main regex found ${figures.length} figures`);
				this.log(`Fallback matches: ${fallbackMatches.join(', ')}`);
			}

			this.figuresByFile.set(file.path, figures);
		} catch (error) {
			this.log(`Error scanning figures in file ${file.path}: ${error}`);
			// Set empty array on error to prevent repeated scanning attempts
			this.figuresByFile.set(file.path, []);
		}
	}

	// Process a specific block for figure captions using document-order based matching
	private processBlockForFigures(el: HTMLElement, figures: FigureInfo[], ctx: MarkdownPostProcessorContext): void {
		try {
			// Look for blockquote elements (these contain captions)
			const blockquotes = el.querySelectorAll('blockquote');
			if (blockquotes.length === 0) {
				return;
			}

			this.log(`Found ${blockquotes.length} blockquotes in block`);

			// Get or initialize the assignment tracking for this file
			let assignedFiguresSet = this.assignedFigures.get(ctx.sourcePath);
			if (!assignedFiguresSet) {
				assignedFiguresSet = new Set<string>();
				this.assignedFigures.set(ctx.sourcePath, assignedFiguresSet);
			}

			// Process each blockquote - assign figures in document order
			blockquotes.forEach((blockquote) => {
				try {
					const paragraph = blockquote.querySelector('p');
					if (!paragraph) {
						return;
					}

					const originalText = paragraph.textContent || '';
					const originalHTML = paragraph.innerHTML || '';
					
					// Check if caption already has a figure number (any figure number)
					if (/^(Figure|איור)\s+[\w\d.-]+:/.test(originalText)) {
						this.log(`Caption already has figure number, skipping`);
						return;
					}
					
					// Find the next available figure in document order
					const nextFigure = this.getNextAvailableFigure(figures, assignedFiguresSet);
					if (!nextFigure) {
						this.log(`No more figures available for caption`);
						return;
					}
					
					// Mark this figure as assigned
					assignedFiguresSet.add(nextFigure.id);
					
					// Remove any existing figure labels (just in case)
					const cleanHTML = originalHTML
						.replace(/^(Figure|איור)\s+[\d.-]+:\s*/i, '')
						.trim();
					
					// Add the figure number with error handling
					if (paragraph && nextFigure) {
						paragraph.innerHTML = `${nextFigure.number}: ${cleanHTML}`;
						this.log(`Assigned ${nextFigure.number} (ID: ${nextFigure.id})`);
					}
				} catch (blockquoteError) {
					this.log(`Error processing blockquote: ${blockquoteError}`);
					// Continue processing other blockquotes
				}
			});
		} catch (error) {
			this.log(`Error processing block for figures: ${error}`);
		}
	}

	// Get the next available figure in document order
	private getNextAvailableFigure(figures: FigureInfo[], assignedSet: Set<string>): FigureInfo | null {
		for (const figure of figures) {
			if (!assignedSet.has(figure.id)) {
				return figure;
			}
		}
		return null;
	}

	// Process figure references in links
	private processFigureReferences(el: HTMLElement, figures: FigureInfo[]): void {
		try {
			const links = el.querySelectorAll('a[href*="#^figure"]');
			
			links.forEach(link => {
				try {
					const href = link.getAttribute('href') || '';
					const figureMatch = href.match(/#\^figure([^\s&]*)/);
					
					if (!figureMatch) return;
					
					const figureId = figureMatch[1];
					const figure = figures.find(f => f.id === figureId);
					
					if (figure) {
						link.textContent = figure.number;
						
						// Add enhanced click behavior for figure references
						link.addEventListener('click', (e) => {
							e.preventDefault();
							this.scrollToFigure(figureId);
						});
						
						this.log(`Updated figure reference: ${href} -> ${figure.number}`);
					}
				} catch (linkError) {
					this.log(`Error processing figure link: ${linkError}`);
					// Continue processing other links
				}
			});
		} catch (error) {
			this.log(`Error processing figure references: ${error}`);
		}
	}

	public scrollToFigure(figureId: string): void {
		try {
			// Look for the figure by searching for elements with the figure ID
			const figureSelector = `[src*="${figureId}"], img[alt*="${figureId}"], [data-figure-id="${figureId}"]`;
			let target = document.querySelector(figureSelector) as HTMLElement;
			
			// Fallback: try to find by block reference
			if (!target) {
				const blockRef = document.querySelector(`[data-block-id="figure${figureId}"]`) as HTMLElement;
				if (blockRef) {
					target = blockRef;
				}
			}
			
			// Another fallback: try standard anchor navigation
			if (!target) {
				window.location.hash = `^figure${figureId}`;
				return;
			}

			if (target) {
				// Enhanced smooth scroll with better visual feedback
				target.scrollIntoView({ 
					behavior: 'smooth', 
					block: 'center',
					inline: 'nearest'
				});
				
				// Add highlight effect to the figure
				const originalTransition = target.style.transition;
				const originalBoxShadow = target.style.boxShadow;
				const originalTransform = target.style.transform;
				
				target.style.transition = 'all 0.3s ease';
				target.style.boxShadow = '0 0 20px var(--text-accent)';
				target.style.transform = 'scale(1.02)';
				
				setTimeout(() => {
					target.style.boxShadow = originalBoxShadow;
					target.style.transform = originalTransform;
					setTimeout(() => {
						target.style.transition = originalTransition;
					}, 300);
				}, 800);
			}
		} catch (error) {
			this.log(`Error scrolling to figure ${figureId}: ${error}`);
			// Fallback: try standard navigation
			window.location.hash = `^figure${figureId}`;
		}
	}

	// Clear cache for a specific file
	private clearCacheForFile(filePath: string): void {
		this.figuresByFile.delete(filePath);
		this.assignedFigures.delete(filePath);
		this.processingLock.delete(filePath);
		// Also clear processed elements to allow re-processing
		this.processedElements = new WeakSet();
		this.log(`Cleared complete cache for file: ${filePath}`);
	}

	// Complete reset of all caches and processed elements
	private resetAllCaches(): void {
		this.figuresByFile.clear();
		this.assignedFigures.clear();
		this.processedElements = new WeakSet();
		this.processingLock.clear();
		this.log(`Reset all caches and processed elements`);
	}

	// Get figure cache with proper line-based lookup
	getFigureByLinePosition(filePath: string, lineStart: number, lineEnd: number): FigureInfo | null {
		try {
			const figures = this.figuresByFile.get(filePath);
			if (!figures) return null;

			// Get assigned figures for this file
			let assignedSet = this.assignedFigures.get(filePath);
			if (!assignedSet) {
				assignedSet = new Set<string>();
				this.assignedFigures.set(filePath, assignedSet);
			}

			// Find the next available figure based on document order
			return this.getNextAvailableFigure(figures, assignedSet);
		} catch (error) {
			this.log(`Error getting figure by line position: ${error}`);
			return null;
		}
	}

	// Mark a figure as assigned
	assignFigure(filePath: string, figureId: string): void {
		let assignedSet = this.assignedFigures.get(filePath);
		if (!assignedSet) {
			assignedSet = new Set<string>();
			this.assignedFigures.set(filePath, assignedSet);
		}
		assignedSet.add(figureId);
	}

	// Find figure by ID
	getFigureById(filePath: string, figureId: string): FigureInfo | null {
		const figures = this.figuresByFile.get(filePath);
		return figures?.find(f => f.id === figureId) || null;
	}

	// Public logging method for render children
	public logMessage(message: string): void {
		this.log(message);
	}

	// PDF export preprocessing - directly apply figure numbers to static HTML
	private async preprocessForPdfExport(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
		try {
			this.log('Processing for PDF export');
			
			// Ensure figures are scanned for this file
			const file = this.app.vault.getFileByPath(ctx.sourcePath);
			if (!file) return;

			let figures = this.figuresByFile.get(ctx.sourcePath);
			if (!figures || figures.length === 0) {
				await this.scanForFigures(file);
				figures = this.figuresByFile.get(ctx.sourcePath);
			}
			if (!figures || figures.length === 0) return;

			// For PDF export, we need to directly modify the HTML since MarkdownRenderChild won't work
			this.processPdfFigureCaptions(el, figures, ctx);
			this.processPdfFigureReferences(el, figures);
			this.processPdfFigureImages(el, figures);

		} catch (error) {
			this.log(`Error in PDF export preprocessing: ${error}`);
		}
	}

	private processPdfFigureCaptions(el: HTMLElement, figures: FigureInfo[], ctx: MarkdownPostProcessorContext): void {
		try {
			const blockquotes = el.querySelectorAll('blockquote');
			let figureIndex = 0;

			blockquotes.forEach((blockquote) => {
				const paragraph = blockquote.querySelector('p');
				if (!paragraph) return;

				const originalText = paragraph.textContent || '';
				
				// Skip if already has figure number
				if (/^(Figure|איור)\s+[\w\d.-]+:/.test(originalText)) {
					return;
				}

				// Assign next figure in order
				if (figureIndex < figures.length) {
					const figure = figures[figureIndex];
					const cleanHTML = paragraph.innerHTML
						.replace(/^(Figure|איור)\s+[\d.-]+:\s*/i, '')
						.trim();
					
					paragraph.innerHTML = `${figure.number}: ${cleanHTML}`;
					this.log(`PDF: Assigned ${figure.number} to caption`);
					figureIndex++;
				}
			});
		} catch (error) {
			this.log(`Error processing PDF figure captions: ${error}`);
		}
	}

	private processPdfFigureReferences(el: HTMLElement, figures: FigureInfo[]): void {
		try {
			const links = el.querySelectorAll('a[href*="#^figure"]');
			
			links.forEach(link => {
				const href = link.getAttribute('href') || '';
				const figureMatch = href.match(/#\^figure([^\s&]*)/);
				
				if (!figureMatch) return;
				
				const figureId = figureMatch[1];
				const figure = figures.find(f => f.id === figureId);
				
				if (figure) {
					link.textContent = figure.number;
					// Remove href for PDF (links won't work anyway)
					link.removeAttribute('href');
					const linkEl = link as HTMLElement;
					linkEl.style.color = 'inherit';
					linkEl.style.textDecoration = 'none';
					this.log(`PDF: Updated figure reference to ${figure.number}`);
				}
			});
		} catch (error) {
			this.log(`Error processing PDF figure references: ${error}`);
		}
	}

	private processPdfFigureImages(el: HTMLElement, figures: FigureInfo[]): void {
		try {
			const images = el.querySelectorAll('img[src], embed[src*=".pdf"]');
			
			images.forEach((img, index) => {
				// Add data attributes for PDF context
				if (index < figures.length) {
					img.setAttribute('data-figure-number', figures[index].number);
					img.setAttribute('data-figure-id', figures[index].id);
					this.log(`PDF: Marked image with ${figures[index].number}`);
				}
			});
		} catch (error) {
			this.log(`Error processing PDF figure images: ${error}`);
		}
	}
}

// Persistent renderer for figure captions using MarkdownRenderChild
class FigureCaptionRenderer extends MarkdownRenderChild {
	constructor(
		containerEl: HTMLElement,
		private app: App,
		private context: MarkdownPostProcessorContext,
		private feature: FigureNumberingFeature
	) {
		super(containerEl);
	}

	async onload() {
		// Register for index updates
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (file.path === this.context.sourcePath) {
					setTimeout(() => this.update(), 100);
				}
			})
		);

		// Initial update with delay
		setTimeout(() => this.update(), 200);
	}

	private update(): void {
		try {
			const paragraph = this.containerEl.querySelector('p');
			if (!paragraph) return;

			const originalText = paragraph.textContent || '';
			
			// Skip if already has figure number
			if (/^(Figure|איור)\s+[\w\d.-]+:/.test(originalText)) {
				return;
			}

			// Get line information for proper figure assignment
			const sectionInfo = this.context.getSectionInfo(this.containerEl);
			if (!sectionInfo) return;

			// Get the next available figure
			const figure = this.feature.getFigureByLinePosition(
				this.context.sourcePath, 
				sectionInfo.lineStart, 
				sectionInfo.lineEnd
			);

			if (figure) {
				this.feature.assignFigure(this.context.sourcePath, figure.id);
				
				// Update caption
				const cleanHTML = paragraph.innerHTML
					.replace(/^(Figure|איור)\s+[\d.-]+:\s*/i, '')
					.trim();
				
				paragraph.innerHTML = `${figure.number}: ${cleanHTML}`;
				this.feature.logMessage(`Assigned ${figure.number} (ID: ${figure.id})`);
			}
		} catch (error) {
			this.feature.logMessage(`Error updating figure caption: ${error}`);
		}
	}
}

// Persistent renderer for figure references
class FigureReferenceRenderer extends MarkdownRenderChild {
	constructor(
		containerEl: HTMLElement,
		private app: App,
		private context: MarkdownPostProcessorContext,
		private feature: FigureNumberingFeature
	) {
		super(containerEl);
	}

	async onload() {
		// Register for index updates
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (file.path === this.context.sourcePath) {
					setTimeout(() => this.update(), 100);
				}
			})
		);

		// Initial update
		setTimeout(() => this.update(), 150);
	}

	private update(): void {
		try {
			const link = this.containerEl as HTMLAnchorElement;
			const href = link.getAttribute('href') || '';
			const figureMatch = href.match(/#\^figure([^\s&]*)/);
			
			if (!figureMatch) return;
			
			const figureId = figureMatch[1];
			const figure = this.feature.getFigureById(this.context.sourcePath, figureId);
			
			if (figure) {
				link.textContent = figure.number;
				
				// Add enhanced click behavior
				link.addEventListener('click', (e) => {
					e.preventDefault();
					this.feature.scrollToFigure(figureId);
				});
				
				this.feature.logMessage(`Updated figure reference: ${href} -> ${figure.number}`);
			}
		} catch (error) {
			this.feature.logMessage(`Error updating figure reference: ${error}`);
		}
	}
}

// Persistent renderer for figure images
class FigureImageRenderer extends MarkdownRenderChild {
	constructor(
		containerEl: HTMLElement,
		private app: App,
		private context: MarkdownPostProcessorContext,
		private feature: FigureNumberingFeature
	) {
		super(containerEl);
	}

	async onload() {
		// Register for updates
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (file.path === this.context.sourcePath) {
					setTimeout(() => this.update(), 100);
				}
			})
		);

		// Initial update
		setTimeout(() => this.update(), 100);
	}

	private update(): void {
		try {
			// Extract figure ID from surrounding context
			const parent = this.containerEl.closest('p, div');
			if (!parent) return;

			const textContent = parent.textContent || '';
			const figureMatch = textContent.match(/\^figure([^\s]*)/);
			
			if (figureMatch) {
				const figureId = figureMatch[1];
				// Add data attribute for figure targeting
				this.containerEl.setAttribute('data-figure-id', figureId);
				this.feature.logMessage(`Marked image with figure ID: ${figureId}`);
			}
		} catch (error) {
			this.feature.logMessage(`Error updating figure image: ${error}`);
		}
	}
} 