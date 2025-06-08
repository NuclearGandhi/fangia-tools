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
					this.scanForFigures(file);
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

		// Route to different features based on settings
		if (this.settings.enableFigureNumbering) {
			await this.processFigureNumbering(el, ctx);
		}

		// Future features can be added here:
		// if (this.settings.enableFeatureX) {
		//     await this.processFeatureX(el, ctx);
		// }
	}

	// ===== FIGURE NUMBERING FEATURE =====

	// Process figure numbering feature
	async processFigureNumbering(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
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

	// Process a specific block for figure captions using stateless assignment
	processBlockForFigures(el: HTMLElement, figures: FigureInfo[], ctx: MarkdownPostProcessorContext) {
		// Look for blockquote elements (these contain captions)
		const blockquotes = el.querySelectorAll('blockquote');
		if (blockquotes.length === 0) {
			return;
		}

		if (this.settings.debugMode) {
			console.log(`Found ${blockquotes.length} blockquotes in block`);
		}

		// Process each blockquote
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
			
			// Find which figure should be assigned to this blockquote
			// We do this by checking what figure numbers are already assigned in the document
			const nextFigure = this.findNextUnassignedFigure(figures, ctx);
			if (!nextFigure) {
				if (this.settings.debugMode) {
					console.log(`No more figures available to assign`);
				}
				return;
			}
			
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
				console.log(`Updated caption with ${nextFigure.number}: "${cleanText}" -> "${nextFigure.number}: ${cleanText}"`);
			}
		});
	}

	// Find the next figure that hasn't been assigned yet
	findNextUnassignedFigure(figures: FigureInfo[], ctx: MarkdownPostProcessorContext): FigureInfo | null {
		// Get the document content to check what figures are already assigned
		const activeLeaf = this.app.workspace.activeLeaf;
		if (!activeLeaf) return figures[0] || null;

		const view = activeLeaf.view as any;
		const contentEl = view.contentEl || view.containerEl;
		if (!contentEl) return figures[0] || null;

		// Find all existing figure numbers in the document
		const allBlockquotes = contentEl.querySelectorAll('blockquote p');
		const assignedNumbers = new Set<string>();
		
		allBlockquotes.forEach((p: Element) => {
			const text = p.textContent || '';
			const match = text.match(/^(Figure|איור)\s+([\w\d.-]+):/);
			if (match) {
				assignedNumbers.add(match[2]); // The figure number part (e.g., "2.1", "HW3.2")
			}
		});

		if (this.settings.debugMode) {
			console.log(`Already assigned figure numbers: [${Array.from(assignedNumbers).join(', ')}]`);
		}

		// Find the first figure that hasn't been assigned
		for (const figure of figures) {
			const figureNumber = figure.number.replace(/^(Figure|איור)\s+/, ''); // Extract just the number part
			if (!assignedNumbers.has(figureNumber)) {
				if (this.settings.debugMode) {
					console.log(`Next unassigned figure: ${figure.number}`);
				}
				return figure;
			}
		}

		return null; // All figures have been assigned
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
					
					// Clear figure cache when toggling to force re-scan
					if (value) {
						this.plugin.figuresByFile.clear();
						// Re-scan current file if in reading view
						const activeFile = this.app.workspace.getActiveFile();
						if (activeFile && this.plugin.isReadingView()) {
							this.plugin.scanForFigures(activeFile);
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

