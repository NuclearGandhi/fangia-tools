import { App, Editor, MarkdownView, Plugin, PluginSettingTab, Setting, MarkdownPostProcessorContext, TFile } from 'obsidian';

// Interface for plugin settings
interface NumberedFiguresSettings {
	// Add settings here if needed in the future
	debugMode: boolean;
}

// Default settings
const DEFAULT_SETTINGS: NumberedFiguresSettings = {
	// Default settings values
	debugMode: false
};

export default class NumberedFiguresPlugin extends Plugin {
	settings: NumberedFiguresSettings;
	figureCounters: Map<string, number> = new Map();
	// Store the figure ID mappings for each file
	figureMappings: Map<string, Map<string, string>> = new Map();

	async onload() {
		console.log('Loading numbered-figures plugin');
		await this.loadSettings();

		// Register a handler to process the document before rendering
		this.registerMarkdownCodeBlockProcessor("figure-id", (source, el, ctx) => {
			// This is a hidden code block just to trigger processing
			el.style.display = "none";
			
			if (this.settings.debugMode) console.log('figure-id code block processor triggered for', ctx.sourcePath);
			
			// Process the document on next tick to ensure all elements are loaded
			setTimeout(() => this.processFiguresInDocument(el, ctx), 0);
		});

		// Register the event to listen for file open
		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				if (file) {
					if (this.settings.debugMode) console.log('File opened:', file.path);
					
					// Reset counters for this file
					this.figureCounters.set(file.path, 0);
					
					// Create a new mapping for this file if it doesn't exist
					if (!this.figureMappings.has(file.path)) {
						this.figureMappings.set(file.path, new Map());
					}
					
					// Pre-process the document to identify all figures
					this.scanDocumentForFigures(file);
				}
			})
		);

		// Register the rendering processor
		this.registerMarkdownPostProcessor((el, ctx) => {
			this.processFiguresInDocument(el, ctx);
		});

		// Add settings tab
		this.addSettingTab(new NumberedFiguresSettingTab(this.app, this));
		
		console.log('Numbered-figures plugin loaded');
	}

	onunload() {
		// Clean up when plugin is disabled
		console.log('Unloading numbered-figures plugin');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// Extract prefix from filename
	getFilePrefix(fileName: string): string {
		// Regular expression to extract prefix from filename patterns like:
		// SLD1_002, HTF1_006, PME2_HW003, etc.
		const prefixMatch = fileName.match(/[A-Z]+\d+_([A-Z]*\d+)/i);
		
		if (this.settings.debugMode) console.log('Extracting prefix from filename:', fileName, 'Match:', prefixMatch);
		
		if (prefixMatch && prefixMatch[1]) {
			// Format the prefix - remove leading zeros
			const prefix = prefixMatch[1].replace(/^0+/, '');
			if (this.settings.debugMode) console.log('Extracted prefix:', prefix);
			return prefix;
		} else {
			// If no match found, use generic prefix
			if (this.settings.debugMode) console.log('No prefix match found, using default "1"');
			return '1';
		}
	}

	// Scan document to identify all figures and their IDs
	async scanDocumentForFigures(file: TFile) {
		// Get the file content
		const content = await this.app.vault.read(file);
		
		// Extract the prefix from the filename
		const fileName = file.basename;
		const prefix = this.getFilePrefix(fileName);
		
		if (this.settings.debugMode) console.log('Scanning document for figures:', file.path);
		
		// Find all occurrences of image links with figure IDs
		// This regex looks for Obsidian image links [[...]] followed immediately by ^figure
		const regex = /\[\[(.*\.(png|jpg|jpeg|gif|bmp|svg|webp))[^\]]*\]\]\^figure([^\s]*)/g;
		let match;
		let counter = 0;
		
		// Create a new mapping for this file
		const fileMapping = new Map<string, string>();
		
		// Find all matches and create mappings
		while ((match = regex.exec(content)) !== null) {
			counter++;
			const figureId = match[3] || ''; // The ID part after ^figure, if any
			const figureNumber = `Figure ${prefix}-${counter}`;
			
			if (this.settings.debugMode) console.log('Found figure:', match[0], '→', figureNumber);
			
			// Store the mapping from ID to number
			fileMapping.set(`^figure${figureId}`, figureNumber);
		}
		
		if (this.settings.debugMode) console.log(`Found ${counter} figures in ${file.path}`);
		
		// Store the mappings for this file
		this.figureMappings.set(file.path, fileMapping);
		this.figureCounters.set(file.path, counter);
	}

	// Process figures in the rendered document
	processFiguresInDocument(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		// Get the mappings for this file
		const fileMappings = this.figureMappings.get(ctx.sourcePath);
		if (!fileMappings || fileMappings.size === 0) {
			if (this.settings.debugMode) console.log('No figure mappings found for', ctx.sourcePath);
			return;
		}
		
		if (this.settings.debugMode) {
			console.log('Processing figures in document:', ctx.sourcePath);
			console.log('Figure mappings:', Object.fromEntries(fileMappings));
			
			el.findAll('img').forEach((img: HTMLImageElement) => {
				console.log('Found image:', img.outerHTML);
			});

			// Check for img tags specifically
			const imgTags = el.querySelectorAll('img');
			console.log('Direct img tags found:', imgTags.length);
			
			if (imgTags.length > 0) {
				Array.from(imgTags).forEach((img, index) => {
					console.log(`Image ${index}:`, img.outerHTML);
				});
			}
		}

		let images = el.findAll('img');
			
		// Process each image (original method)
		images.forEach((img: HTMLImageElement) => {
			// Check if this is part of a figure we need to number
			const imgSrc = img.getAttribute('src') || '';
			if (this.settings.debugMode) console.log('Processing image:', imgSrc);
			
			// Get the parent div containing the image
			const imgContainer = img.closest('div') || img.parentElement;
			if (!imgContainer) {
				if (this.settings.debugMode) console.log('No parent container found for image');
				return;
			}
			
			// Now look for the next sibling which should be the caption container
			let captionContainer = imgContainer.nextElementSibling;
			
			// If we found a potential caption container, check if it contains a blockquote
			if (captionContainer) {
				const blockquote = captionContainer.querySelector('blockquote');
				if (blockquote) {
					const paragraph = blockquote.querySelector('p');
					if (paragraph) {
						// This could be a caption paragraph, check if it contains any of our figure IDs
						const paragraphText = paragraph.textContent || '';
						
						// Log the paragraph text for debugging
						if (this.settings.debugMode) console.log('Found caption paragraph:', paragraphText);
						
						// Check if this paragraph contains any of our figure IDs
						for (const [figureId, figureNumber] of fileMappings.entries()) {
							if (paragraphText.includes(figureId)) {
								// We found a match! This is a figure caption we need to number
								if (this.settings.debugMode) console.log('Found matching figure ID:', figureId);
								
								// Replace the figure ID with the figure number
								// But make sure to add it at the beginning of the caption if it's not already there
								let newText: string;
								if (paragraphText.trim().startsWith(figureId)) {
									// If the ID is at the start, just replace it
									newText = paragraphText.replace(figureId, figureNumber);
								} else {
									// Otherwise, remove the ID from wherever it is and add the figure number at the start
									newText = figureNumber + ' ' + paragraphText.replace(figureId, '').trim();
								}
								
								// Update the paragraph text
								paragraph.textContent = newText;
								
								if (this.settings.debugMode) console.log('Updated caption to:', newText);
								break; // Break once we've found and processed a match
							}
						}
					}
				}
			}
		});
	}
}

class NumberedFiguresSettingTab extends PluginSettingTab {
	plugin: NumberedFiguresPlugin;

	constructor(app: App, plugin: NumberedFiguresPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();
		containerEl.createEl('h2', {text: 'Numbered Figures Settings'});

		new Setting(containerEl)
			.setName('Debug Mode')
			.setDesc('Enable debug logging to console (useful for troubleshooting)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.debugMode)
				.onChange(async (value) => {
					this.plugin.settings.debugMode = value;
					await this.plugin.saveSettings();
					console.log('Debug mode ' + (value ? 'enabled' : 'disabled'));
				}));

		new Setting(containerEl)
			.setName('About')
			.setDesc('This plugin adds automatic numbering to figures in your notes based on file naming.');
	}
}

