import { App, MarkdownPostProcessorContext } from 'obsidian';
import { BaseFeature, FeatureSettings } from './base-feature';

interface ExampleFeatureSettings extends FeatureSettings {
	enableExampleFeature: boolean;
}

export class ExampleFeature extends BaseFeature {
	private app: App;

	constructor(app: App, debugMode: boolean = false) {
		super(debugMode);
		this.app = app;
	}

	getName(): string {
		return 'ExampleFeature';
	}

	isEnabled(settings: ExampleFeatureSettings): boolean {
		return settings.enableExampleFeature;
	}

	async process(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
		this.log(`Processing element: ${el.tagName}.${el.className}`);
		
		// Example: Add a special class to all paragraphs
		const paragraphs = el.querySelectorAll('p');
		paragraphs.forEach(p => {
			if (!p.classList.contains('fangia-processed')) {
				p.classList.add('fangia-processed');
				this.log(`Added class to paragraph: ${p.textContent?.substring(0, 30)}...`);
			}
		});
	}

	onFileOpen(filePath: string): void {
		this.log(`File opened: ${filePath}`);
		// Handle file open events
	}

	onLayoutChange(): void {
		this.log('Layout changed');
		// Handle layout change events
	}

	cleanup(): void {
		this.log('Cleaning up example feature');
		// Clean up any resources, caches, etc.
	}
}

// To use this feature, add it to the features array in main.ts:
// this.features = [
//     new FigureNumberingFeature(this.app, this.settings.debugMode),
//     new ExampleFeature(this.app, this.settings.debugMode)
// ];
// 
// And add the corresponding setting to FangiaToolsSettings interface:
// interface FangiaToolsSettings {
//     enableFigureNumbering: boolean;
//     enableExampleFeature: boolean;
//     debugMode: boolean;
// } 