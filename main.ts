import { 
	App, 
	Plugin, 
	PluginSettingTab, 
	Setting, 
	MarkdownPostProcessorContext
} from 'obsidian';
import { BaseFeature } from './features/base-feature';
import { FigureNumberingFeature } from './features/figure-numbering';
import { EquationReferencesFeature } from './features/equation-references';
import { ViewUtils } from './utils/view-utils';

interface FangiaToolsSettings {
	// Figure numbering feature
	enableFigureNumbering: boolean;
	// Equation references feature
	enableEquationReferences: boolean;
	debugMode: boolean;
}

const DEFAULT_SETTINGS: FangiaToolsSettings = {
	enableFigureNumbering: true,
	enableEquationReferences: true,
	debugMode: false
};

export default class FangiaToolsPlugin extends Plugin {
	settings: FangiaToolsSettings;
	// Feature instances
	features: BaseFeature[] = [];
	// Track processed elements to prevent duplicates
	private processedElements: WeakSet<HTMLElement> = new WeakSet();

	async onload() {
		console.log('Loading Fangia Tools plugin');
		await this.loadSettings();

		// Initialize features
		this.initializeFeatures();

		// Main post-processor that routes to different features
		this.registerMarkdownPostProcessor((el, ctx) => {
			this.processDocument(el, ctx);
		});

		// Listen for file changes
		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				if (file) {
					this.features.forEach(feature => {
						if (feature.onFileOpen && feature.isEnabled(this.settings)) {
							feature.onFileOpen(file.path);
						}
					});
				}
			})
		);

		// Listen for layout changes
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				if (ViewUtils.isReadingView(this.app)) {
					this.features.forEach(feature => {
						if (feature.onLayoutChange && feature.isEnabled(this.settings)) {
							feature.onLayoutChange();
						}
					});
				}
			})
		);

		this.addSettingTab(new FangiaToolsSettingTab(this.app, this));
		console.log('Fangia Tools plugin loaded');
	}

	// Initialize all features
	initializeFeatures() {
		this.features = [
			new FigureNumberingFeature(this.app, this.settings.debugMode),
			new EquationReferencesFeature(this.app, this.settings.debugMode)
		];
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		// Update feature debug modes when settings change
		this.updateFeatureSettings();
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.updateFeatureSettings();
	}

	// Update feature settings when main settings change
	updateFeatureSettings() {
		this.features.forEach(feature => {
			(feature as any).debugMode = this.settings.debugMode;
		});
	}

	// Main processing function - routes to different reading view features
	async processDocument(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		// Only process in reading view
		if (!ViewUtils.isReadingView(this.app)) {
			return;
		}

		// Skip irrelevant blocks (frontmatter, code blocks, etc.)
		if (ViewUtils.shouldSkipElement(el)) {
			return;
		}

		// Prevent duplicate processing of the same element
		if (this.processedElements.has(el)) {
			if (this.settings.debugMode) {
				console.log(`Element already processed, skipping: ${el.tagName}.${el.className}`);
			}
			return;
		}

		// Process with enabled features
		for (const feature of this.features) {
			if (feature.isEnabled(this.settings)) {
				await feature.process(el, ctx);
			}
		}

		// Mark element as processed
		this.processedElements.add(el);
	}

	// ===== SHARED UTILITIES =====

	// Complete reset of all caches and processed elements
	resetAllCaches() {
		this.processedElements = new WeakSet();
		this.features.forEach(feature => {
			if (feature.cleanup) {
				feature.cleanup();
			}
		});
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
						if (activeFile && ViewUtils.isReadingView(this.app)) {
							const figureFeature = this.plugin.features.find(f => f.getName() === 'FigureNumbering');
							if (figureFeature && figureFeature.onFileOpen) {
							setTimeout(() => {
									figureFeature.onFileOpen!(activeFile.path);
							}, 100);
							}
						}
					}
				}));

		// Equation references section
		containerEl.createEl('h3', { text: 'Equation References' });

		new Setting(containerEl)
			.setName('Enable Equation References')
			.setDesc('Convert equation references like $\\text{(4.13)}$ into clickable links to equations with \\tag{4.13}')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableEquationReferences)
				.onChange(async (value) => {
					this.plugin.settings.enableEquationReferences = value;
					await this.plugin.saveSettings();
					
					// Complete reset when toggling to ensure clean state
					this.plugin.resetAllCaches();
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


