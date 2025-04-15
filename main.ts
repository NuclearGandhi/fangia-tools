import { 
	App, 
	Editor, 
	MarkdownView, 
	Plugin, 
	PluginSettingTab, 
	Setting, 
	MarkdownPostProcessorContext, 
	TFile,
	MarkdownRenderer,
	EditorPosition
} from 'obsidian';

// Import CodeMirror editor extension types
import { EditorView, ViewPlugin, ViewUpdate, PluginValue } from '@codemirror/view';
import { EditorState, StateField, StateEffect, Transaction, Extension } from '@codemirror/state';

// Interface for plugin settings
interface NumberedFiguresSettings {
	// Add settings here if needed in the future
	debugMode: boolean;
}

// Define a more structured type for figure information
interface FigureInfo {
	figureId: string;      // The figure ID (if any)
	figureNumber: string;  // The formatted figure number (e.g., "Figure 1-2")
	imageSrc: string;      // The source path of the image
}

// Interface for figure state tracking
interface FigureState {
	filePath: string;
	figures: FigureInfo[];
	isProcessed: boolean;
}

// Define effect for updating figure state
const updateFigureState = StateEffect.define<FigureState>();

// Create a StateField to track figure state
const figureStateField = StateField.define<FigureState>({
	create(state: EditorState): FigureState {
		// Initial empty state with default values
		return { filePath: "", figures: [], isProcessed: false };
	},
	
	update(oldState: FigureState, transaction: Transaction): FigureState {
		// Process any state update effects
		for (const effect of transaction.effects) {
			if (effect.is(updateFigureState)) {
				return effect.value;
			}
		}
		
		// Default: return previous state if no effects were applied
		return oldState;
	},
	
	// This field isn't used directly for rendering, only for state tracking
	provide(field: StateField<FigureState>): Extension {
		return field;
	}
});

// Default settings
const DEFAULT_SETTINGS: NumberedFiguresSettings = {
	// Default settings values
	debugMode: false
};

// Define figure text based on language
const FIGURE_TEXT = {
	english: "Figure",
	hebrew: "איור"
};

// Create a ViewPlugin to process figures based on state changes
function createFigureViewPlugin(plugin: NumberedFiguresPlugin) {
	return ViewPlugin.fromClass(class {
		constructor(private view: EditorView) {
			// Initial processing
			this.processFigures();
		}
		
		update(update: ViewUpdate) {
			// Get the current figure state
			const state = update.state.field(figureStateField);
			
			// Process figures if state changed or document changed
			if (update.docChanged || !state.isProcessed) {
				this.processFigures();
			}
		}
		
		processFigures() {
			// Get active file
			const activeFile = plugin.app.workspace.getActiveFile();
			if (!activeFile) return;
			
			const filePath = activeFile.path;
			const figureInfos = plugin.figureInfoByFile.get(filePath);
			
			if (!figureInfos || figureInfos.length === 0) {
				if (plugin.settings.debugMode) console.log('No figure info found for', filePath);
				return;
			}
			
			// Mark that we've started processing
			this.updateState(filePath, figureInfos, false);
			
			if (plugin.settings.debugMode) console.log('Processing figures in:', filePath);
			
			// Get the parent element of the editor view
			const contentEl = this.view.contentDOM.parentElement;
			if (!contentEl) return;
			
			// Find all images in the view
			const images = contentEl.querySelectorAll('img[src]') as NodeListOf<HTMLImageElement>;
			if (plugin.settings.debugMode) console.log('Found images:', images.length);
			
			// Process each image
			images.forEach((img: HTMLImageElement) => {
				// Get the image source
				const imgSrc = img.getAttribute('src') || '';
				// Extract filename from path
				const srcParts = imgSrc.split('/').pop()?.split('?')[0] || '';
				// Decode URL-encoded characters
				const escapedSrcParts = decodeURIComponent(srcParts);
				
				if (plugin.settings.debugMode) console.log('Processing image:', imgSrc, 'extracted name:', escapedSrcParts);
				
				// Find matching figure info
				const matchingFigureInfo = figureInfos.find(info => 
					imgSrc.includes(info.imageSrc) || 
					info.imageSrc.includes(escapedSrcParts)
				);
				
				// Skip if no match found
				if (!matchingFigureInfo) {
					if (plugin.settings.debugMode) console.log('No figure info found for image:', imgSrc);
					return;
				}
				
				this.applyFigureNumber(img, matchingFigureInfo);
			});
			
			// Mark processing as complete
			this.updateState(filePath, figureInfos, true);
		}
		
		applyFigureNumber(img: HTMLImageElement, figureInfo: FigureInfo) {
			if (plugin.settings.debugMode) console.log('Applying figure number:', figureInfo.figureNumber);
			
			// Get the container elements
			const imgContainer = img.closest('div') || img.parentElement;
			if (!imgContainer) {
				if (plugin.settings.debugMode) console.log('No parent container found for image');
				return;
			}
			
			// Look for caption (next sibling with blockquote)
			let captionContainer = imgContainer.nextElementSibling;
			if (!captionContainer) return;
			
			const blockquote = captionContainer.querySelector('blockquote');
			if (!blockquote) return;
			
			const paragraph = blockquote.querySelector('p');
			if (!paragraph) return;
			
			// Get caption text and update it
			const paragraphText = paragraph.textContent || '';
			
			if (plugin.settings.debugMode) console.log('Found caption paragraph:', paragraphText);
			
			// Get language-specific figure text
			const englishFigureText = FIGURE_TEXT.english;
			const hebrewFigureText = FIGURE_TEXT.hebrew;
			
			// Replace existing figure number with new one
			let newText = figureInfo.figureNumber + ': ' + 
				paragraphText
					.replace(new RegExp(`^${englishFigureText}\\s+[\\w\\d.-]+:\\s*`, 'i'), '')
					.replace(new RegExp(`^${hebrewFigureText}\\s+[\\w\\d.-]+:\\s*`, 'i'), '')
					.trim();
			
			// Update paragraph text
			paragraph.textContent = newText;
			
			if (plugin.settings.debugMode) console.log('Updated caption to:', newText);
		}
		
		updateState(filePath: string, figures: FigureInfo[], isProcessed: boolean) {
			// Create a state update effect
			const effect = updateFigureState.of({ 
				filePath, 
				figures, 
				isProcessed 
			});
			
			// Apply the effect to update state
			this.view.dispatch({
				effects: [effect]
			});
		}
	});
}

export default class NumberedFiguresPlugin extends Plugin {
	settings: NumberedFiguresSettings;
	figureCounters: Map<string, number> = new Map();
	// Store the figure information for each file using the new FigureInfo type
	figureInfoByFile: Map<string, FigureInfo[]> = new Map();

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

					// Pre-process the document to identify all figures
					this.scanDocumentForFigures(file);
				}
			})
		);

		// Register our StateField and ViewPlugin editor extensions
		this.registerEditorExtension([
			figureStateField,
			createFigureViewPlugin(this)
		]);

		// Register the rendering processor as a fallback
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

	// Helper function to detect if content is in Hebrew based on first heading
	isHebrewContent(content: string): boolean {
		// Look for the first heading in the document
		const headingMatch = content.match(/^#+\s+(.+)$/m);
		if (headingMatch && headingMatch[1]) {
			const headingText = headingMatch[1].trim();
			// Check if the first character is a Hebrew character
			// Hebrew Unicode range is \u0590-\u05FF
			const firstChar = headingText.charAt(0);
			return /[\u0590-\u05FF]/.test(firstChar);
		}
		return false;
	}

	// Scan document to identify all figures and their IDs
	async scanDocumentForFigures(file: TFile) {
		// Get the file content
		const content = await this.app.vault.read(file);

		// Detect if content is in Hebrew
		const isHebrew = this.isHebrewContent(content);
		if (this.settings.debugMode) console.log('Document language:', isHebrew ? 'Hebrew' : 'English');

		// Extract the prefix from the filename
		const fileName = file.basename;
		const prefix = this.getFilePrefix(fileName);

		if (this.settings.debugMode) console.log('Scanning document for figures:', file.path);

		// Find all occurrences of image links with figure IDs
		// This regex looks for Obsidian image links [[...]] followed immediately by ^figure
		const regex = /\[\[(.*\.(png|jpg|jpeg|gif|bmp|svg|webp))[^\]]*\]\]\^figure([^\s]*)/g;
		let match;
		let counter = 0;

		// Create a new array to store figure info for this file
		const figuresForFile: FigureInfo[] = [];

		// Get the appropriate figure text based on language
		const figureText = isHebrew ? FIGURE_TEXT.hebrew : FIGURE_TEXT.english;

		// Find all matches and create mappings
		while ((match = regex.exec(content)) !== null) {
			counter++;
			const imageSrc = match[1].trim(); // The image path inside the brackets
			const figureId = match[3] || ''; // The ID part after ^figure, if any
			// Use dot separator instead of hyphen
			const figureNumber = `${figureText} ${prefix}.${counter}`;

			if (this.settings.debugMode) console.log('Found figure:', match[0], '→', figureNumber, 'with src:', imageSrc);

			// Create a FigureInfo object and add it to our array
			figuresForFile.push({
				figureId: figureId,
				figureNumber: figureNumber,
				imageSrc: imageSrc
			});
		}

		if (this.settings.debugMode) console.log(`Found ${counter} figures in ${file.path}`);

		// Store the figure info for this file
		this.figureInfoByFile.set(file.path, figuresForFile);
		this.figureCounters.set(file.path, counter);
	}

	// Process figures in the rendered document
	processFiguresInDocument(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		if (this.settings.debugMode) console.log('Processing figures in document:', ctx.sourcePath);

		// Get the figure info for this file
		const figureInfos = this.figureInfoByFile.get(ctx.sourcePath);
		
		if (!figureInfos || figureInfos.length === 0) {
			if (this.settings.debugMode) console.log('No figure info found for', ctx.sourcePath);
			return;
		}

		if (this.settings.debugMode) console.log('Figure info found:', figureInfos);

		let images = document.querySelectorAll('img[src]') as NodeListOf<HTMLImageElement>;
		if (this.settings.debugMode) console.log('Found images:', images.length);

		// Process each image using source as identifier
		images.forEach((img: HTMLImageElement) => {
			// Get the image source
			const imgSrc = img.getAttribute('src') || '';
			// Extract just the filename from the path (without query parameters)
			const srcParts = imgSrc.split('/').pop()?.split('?')[0] || '';
			// Decode the filename to handle any URL-encoded characters
			const escapedSrcParts = decodeURIComponent(srcParts);			
			if (this.settings.debugMode) console.log('Processing image:', imgSrc, 'extracted name:', escapedSrcParts);
			
			// Find matching figure info for this image
			const matchingFigureInfo = figureInfos.find(info => 
				imgSrc.includes(info.imageSrc) || 
				info.imageSrc.includes(escapedSrcParts)
			);
			
			// If no figure info found, skip this image
			if (!matchingFigureInfo) {
				if (this.settings.debugMode) console.log('No figure info found for image:', imgSrc);
				return;
			}
			
			if (this.settings.debugMode) console.log('Found matching figure:', matchingFigureInfo.figureNumber);

			// Get the parent div containing the image
			const imgContainer = img.closest('div') || img.parentElement;
			if (!imgContainer) {
				if (this.settings.debugMode) console.log('No parent container found for image');
				return;
			}

			// Now look for the next sibling which should be the caption container
			let captionContainer = imgContainer.nextElementSibling;

			// If we found a potential caption container, check if it contains a blockquote
			if (!captionContainer)
				return;

			const blockquote = captionContainer.querySelector('blockquote');
			if (!blockquote)
				return;

			const paragraph = blockquote.querySelector('p');
			if (!paragraph)
				return;

			// This is a caption paragraph, update it with the figure number
			const paragraphText = paragraph.textContent || '';

			// Log the paragraph text for debugging
			if (this.settings.debugMode) console.log('Found caption paragraph:', paragraphText);

			// Get language-specific figure text
			const englishFigureText = FIGURE_TEXT.english;
			const hebrewFigureText = FIGURE_TEXT.hebrew;

			// Format the new text with the figure number at the start
			// Replace any existing figure label (in either language) with the new one
			// Updated to handle both hyphen and dot formats
			let newText = matchingFigureInfo.figureNumber + ': ' + 
				paragraphText
					.replace(new RegExp(`^${englishFigureText}\\s+[\\w\\d.-]+:\\s*`, 'i'), '')
					.replace(new RegExp(`^${hebrewFigureText}\\s+[\\w\\d.-]+:\\s*`, 'i'), '')
					.trim();

			// Update the paragraph text
			paragraph.textContent = newText;

			if (this.settings.debugMode) console.log('Updated caption to:', newText);
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
		const { containerEl } = this;

		containerEl.empty();
		containerEl.createEl('h2', { text: 'Numbered Figures Settings' });

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

