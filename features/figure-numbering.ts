import { App, TFile, MarkdownPostProcessorContext } from 'obsidian';
import { BaseFeature, FeatureSettings } from './base-feature';

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
		// Prevent duplicate processing of the same element
		if (this.processedElements.has(el)) {
			this.log(`Element already processed, skipping: ${el.tagName}.${el.className}`);
			return;
		}

		// Check for processing lock to prevent race conditions
		if (this.processingLock.get(ctx.sourcePath)) {
			this.log(`Processing locked for file: ${ctx.sourcePath}`);
			return;
		}

		// Set processing lock
		this.processingLock.set(ctx.sourcePath, true);

		try {
			let figures = this.figuresByFile.get(ctx.sourcePath);
			if (!figures || figures.length === 0) {
				// If figures haven't been scanned yet, scan them now
				const file = this.app.vault.getFileByPath(ctx.sourcePath);
				if (file) {
					await this.scanForFigures(file);
					figures = this.figuresByFile.get(ctx.sourcePath);
				}
				if (!figures || figures.length === 0) {
					return;
				}
			}

			this.log(`Processing block for figure numbering: ${el.tagName}.${el.className}`);

			// Process figure captions by matching the block content to figure patterns
			this.processBlockForFigures(el, figures, ctx);
			
			// Process figure references in links
			this.processFigureReferences(el, figures);

			// Mark element as processed
			this.processedElements.add(el);
		} finally {
			// Always release the processing lock
			this.processingLock.delete(ctx.sourcePath);
		}
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
			const figureRegex = /!\[\[([^\]]+\.(png|jpg|jpeg|gif|bmp|svg|webp|pdf)[^\]]*)\]\]\^figure([^\s]*)/gi;
			const figures: FigureInfo[] = [];
			let match;
			let counter = 1;

			while ((match = figureRegex.exec(content)) !== null) {
				const imagePath = match[1].trim();
				const figureId = match[3] || '';
				const figureNumber = `${figureText} ${prefix}.${counter}`;

				figures.push({
					number: figureNumber,
					id: figureId,
					imagePath: imagePath
				});

				this.log(`Found figure: ${imagePath} -> ${figureNumber} (ID: ${figureId})`);

				counter++;
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

	private scrollToFigure(figureId: string): void {
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
} 