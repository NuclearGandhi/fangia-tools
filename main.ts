import { 
	App, 
	Plugin, 
	PluginSettingTab, 
	Setting, 
	MarkdownPostProcessorContext, 
	TFile
} from 'obsidian';

interface FangiaToolsSettings {
	// Figure numbering feature
	enableFigureNumbering: boolean;
	debugMode: boolean;
}

interface FigureInfo {
	number: string;
	id: string;
	imagePath: string;
}

const DEFAULT_SETTINGS: FangiaToolsSettings = {
	enableFigureNumbering: true,
	debugMode: false
};

const FIGURE_TEXT = {
	english: "Figure",
	hebrew: "איור"
};

export default class FangiaToolsPlugin extends Plugin {
	settings: FangiaToolsSettings;
	// Store figure information per file
	figuresByFile: Map<string, FigureInfo[]> = new Map();
	// Track which figures have been assigned per file
	assignedFigures: Map<string, Set<string>> = new Map();
	// Track processed elements to prevent duplicates
	private processedElements: WeakSet<HTMLElement> = new WeakSet();
	// Track current view mode to detect changes
	private lastViewMode: string | null = null;
	// Processing lock to prevent race conditions
	private processingLock: Map<string, boolean> = new Map();

	async onload() {
		console.log('Loading Fangia Tools plugin');
		await this.loadSettings();

		// Main post-processor that routes to different features
		this.registerMarkdownPostProcessor((el, ctx) => {
			this.processDocument(el, ctx);
		});

		// Listen for file changes to refresh figure numbering
		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				if (file && this.settings.enableFigureNumbering) {
					this.clearCacheForFile(file.path);
					this.scanForFigures(file);
				}
			})
		);

		// Listen for layout changes but with much less aggressive cache clearing
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				// Only trigger a delayed re-scan if we're in reading view and have no figures cached
				if (this.isReadingView() && this.settings.enableFigureNumbering) {
					const activeFile = this.app.workspace.getActiveFile();
					if (activeFile && !this.figuresByFile.has(activeFile.path)) {
						setTimeout(() => {
							this.scanForFigures(activeFile);
						}, 500);
					}
				}
			})
		);

		this.addSettingTab(new FangiaToolsSettingTab(this.app, this));
		console.log('Fangia Tools plugin loaded');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// Main processing function - routes to different reading view features
	async processDocument(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		// Only process in reading view
		if (!this.isReadingView()) {
			return;
		}

		// Skip irrelevant blocks (frontmatter, code blocks, etc.)
		if (el.classList.contains('mod-frontmatter') || 
			el.classList.contains('mod-header') ||
			el.tagName === 'PRE' ||
			el.classList.contains('frontmatter')) {
			return;
		}

		// Prevent duplicate processing of the same element
		if (this.processedElements.has(el)) {
			if (this.settings.debugMode) {
				console.log(`Element already processed, skipping: ${el.tagName}.${el.className}`);
			}
			return;
		}

		// Check for processing lock to prevent race conditions
		if (this.processingLock.get(ctx.sourcePath)) {
			if (this.settings.debugMode) {
				console.log(`Processing locked for file: ${ctx.sourcePath}`);
			}
			return;
		}

		// Route to different features based on settings
		if (this.settings.enableFigureNumbering) {
			await this.processFigureNumbering(el, ctx);
		}

		// Mark element as processed
		this.processedElements.add(el);

		// Future features can be added here:
		// if (this.settings.enableFeatureX) {
		//     await this.processFeatureX(el, ctx);
		// }
	}

	// ===== FIGURE NUMBERING FEATURE =====

	// Process figure numbering feature
	async processFigureNumbering(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
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

			if (this.settings.debugMode) {
				console.log(`Processing block for figure numbering: ${el.tagName}.${el.className}`);
			}

			// Process figure captions by matching the block content to figure patterns
			this.processBlockForFigures(el, figures, ctx);
			
			// Process figure references in links
			this.processFigureReferences(el, figures);
		} finally {
			// Always release the processing lock
			this.processingLock.delete(ctx.sourcePath);
		}
	}

	// Extract file prefix for figure numbering (e.g., "SLD1_002" -> "2", "IRB1_HW003" -> "HW3")
	getFilePrefix(fileName: string): string {
		const prefixMatch = fileName.match(/[A-Z]+\d+_([A-Z]*\d+)/i);
		if (prefixMatch && prefixMatch[1]) {
			// Remove leading zeros from numbers while preserving letters
			const prefix = prefixMatch[1].replace(/(\D*)0*(\d+)/, '$1$2');
			return prefix || '1';
		}
		return '1';
	}

	// Detect if content is Hebrew based on first heading
	isHebrewContent(content: string): boolean {
		const headingMatch = content.match(/^#+\s+(.+)$/m);
		if (headingMatch && headingMatch[1]) {
			const firstChar = headingMatch[1].trim().charAt(0);
			return /[\u0590-\u05FF]/.test(firstChar);
		}
		return false;
	}

	// Scan document for figures and create numbering
	async scanForFigures(file: TFile) {
		const content = await this.app.vault.read(file);
		const isHebrew = this.isHebrewContent(content);
		const prefix = this.getFilePrefix(file.basename);
		const figureText = isHebrew ? FIGURE_TEXT.hebrew : FIGURE_TEXT.english;

		// Find all figure references: ![[image.ext]]^figureID
		const figureRegex = /!\[\[([^\]]+\.(png|jpg|jpeg|gif|bmp|svg|webp)[^\]]*)\]\]\^figure([^\s]*)/gi;
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

			if (this.settings.debugMode) {
				console.log(`Found figure: ${imagePath} -> ${figureNumber} (ID: ${figureId})`);
			}

			counter++;
		}

		this.figuresByFile.set(file.path, figures);
	}

	// Process a specific block for figure captions using document-order based matching
	processBlockForFigures(el: HTMLElement, figures: FigureInfo[], ctx: MarkdownPostProcessorContext) {
		// Look for blockquote elements (these contain captions)
		const blockquotes = el.querySelectorAll('blockquote');
		if (blockquotes.length === 0) {
			return;
		}

		if (this.settings.debugMode) {
			console.log(`Found ${blockquotes.length} blockquotes in block`);
		}

		// Get or initialize the assignment tracking for this file
		let assignedFiguresSet = this.assignedFigures.get(ctx.sourcePath);
		if (!assignedFiguresSet) {
			assignedFiguresSet = new Set<string>();
			this.assignedFigures.set(ctx.sourcePath, assignedFiguresSet);
		}

		// Process each blockquote - assign figures in document order
		blockquotes.forEach((blockquote) => {
			const paragraph = blockquote.querySelector('p');
			if (!paragraph) {
				return;
			}

			const originalText = paragraph.textContent || '';
			const originalHTML = paragraph.innerHTML || '';
			
			// Check if caption already has a figure number (any figure number)
			if (/^(Figure|איור)\s+[\w\d.-]+:/.test(originalText)) {
				if (this.settings.debugMode) {
					console.log(`Caption already has figure number, skipping: "${originalText.substring(0, 50)}..."`);
				}
				return;
			}
			
			// Find the next available figure in document order
			const nextFigure = this.getNextAvailableFigure(figures, assignedFiguresSet);
			if (!nextFigure) {
				if (this.settings.debugMode) {
					console.log(`No more figures available for caption: "${originalText.substring(0, 30)}..."`);
				}
				return;
			}
			
			// Mark this figure as assigned
			assignedFiguresSet.add(nextFigure.id);
			
			// Remove any existing figure labels (just in case)
			const cleanText = originalText
				.replace(/^(Figure|איור)\s+[\d.-]+:\s*/i, '')
				.trim();

			const cleanHTML = originalHTML
				.replace(/^(Figure|איור)\s+[\d.-]+:\s*/i, '')
				.trim();
			
			// Add the figure number
			paragraph.innerHTML = `${nextFigure.number}: ${cleanHTML}`;

			if (this.settings.debugMode) {
				console.log(`Assigned ${nextFigure.number} to caption: "${cleanText}" (Figure ID: ${nextFigure.id})`);
			}
		});
	}

	// Get the next available figure in document order
	getNextAvailableFigure(figures: FigureInfo[], assignedSet: Set<string>): FigureInfo | null {
		for (const figure of figures) {
			if (!assignedSet.has(figure.id)) {
				return figure;
			}
		}
		return null;
	}



	// Process figure references in links
	processFigureReferences(el: HTMLElement, figures: FigureInfo[]) {
		const links = el.querySelectorAll('a[href*="#^figure"]');
		
		links.forEach(link => {
			const href = link.getAttribute('href') || '';
			const figureMatch = href.match(/#\^figure([^\s&]*)/);
			
			if (!figureMatch) return;
			
			const figureId = figureMatch[1];
			const figure = figures.find(f => f.id === figureId);
			
			if (figure) {
				link.textContent = figure.number;
				
				if (this.settings.debugMode) {
					console.log(`Updated figure reference: ${href} -> ${figure.number}`);
				}
			}
		});
	}

	// ===== SHARED UTILITIES =====

	// Check if we're in reading view
	isReadingView(): boolean {
		const activeLeaf = this.app.workspace.activeLeaf;
		if (!activeLeaf || activeLeaf.view.getViewType() !== 'markdown') {
			return false;
		}
		
		// Check if the view has a reading mode (preview mode)
		const markdownView = activeLeaf.view as any;
		return markdownView.getMode && markdownView.getMode() === 'preview';
	}

	// Get current view mode
	getCurrentViewMode(): string | null {
		const activeLeaf = this.app.workspace.activeLeaf;
		if (!activeLeaf || activeLeaf.view.getViewType() !== 'markdown') {
			return null;
		}
		const markdownView = activeLeaf.view as any;
		return markdownView.getMode && markdownView.getMode();
	}

	// Clear cache for a specific file
	clearCacheForFile(filePath: string) {
		this.figuresByFile.delete(filePath);
		this.assignedFigures.delete(filePath);
		this.processingLock.delete(filePath);
		// Also clear processed elements to allow re-processing
		this.processedElements = new WeakSet();
		if (this.settings.debugMode) {
			console.log(`Cleared complete cache for file: ${filePath}`);
		}
	}

	// Complete reset of all caches and processed elements
	resetAllCaches() {
		this.figuresByFile.clear();
		this.assignedFigures.clear();
		this.processedElements = new WeakSet();
		this.processingLock.clear();
		if (this.settings.debugMode) {
			console.log(`Reset all caches and processed elements`);
		}
	}
}

class FangiaToolsSettingTab extends PluginSettingTab {
	plugin: FangiaToolsPlugin;

	constructor(app: App, plugin: FangiaToolsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();
		containerEl.createEl('h2', { text: 'Fangia Tools Settings' });

		// Figure numbering section
		containerEl.createEl('h3', { text: 'Figure Numbering' });

		new Setting(containerEl)
			.setName('Enable Figure Numbering')
			.setDesc('Automatically number figures in reading view (format: ![[image.png]]^figureID)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableFigureNumbering)
				.onChange(async (value) => {
					this.plugin.settings.enableFigureNumbering = value;
					await this.plugin.saveSettings();
					
					// Complete reset when toggling to ensure clean state
					this.plugin.resetAllCaches();
					
					// Re-scan current file if enabling and in reading view
					if (value) {
						const activeFile = this.app.workspace.getActiveFile();
						if (activeFile && this.plugin.isReadingView()) {
							setTimeout(() => {
								this.plugin.scanForFigures(activeFile);
							}, 100);
						}
					}
				}));

		// Debug section
		containerEl.createEl('h3', { text: 'Debug' });

		new Setting(containerEl)
			.setName('Debug Mode')
			.setDesc('Enable debug logging to console')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.debugMode)
				.onChange(async (value) => {
					this.plugin.settings.debugMode = value;
					await this.plugin.saveSettings();
				}));

		// Future features section placeholder
		containerEl.createEl('h3', { text: 'Future Features' });
		containerEl.createEl('p', { 
			text: 'Additional reading view enhancements will be added here.',
			cls: 'setting-item-description'
		});
	}
}


