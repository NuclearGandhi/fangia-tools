import { MarkdownPostProcessorContext } from 'obsidian';

export interface FeatureSettings {
	[key: string]: any;
}

export abstract class BaseFeature {
	protected debugMode: boolean;

	constructor(debugMode: boolean = false) {
		this.debugMode = debugMode;
	}

	abstract getName(): string;
	abstract isEnabled(settings: FeatureSettings): boolean;
	abstract process(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void>;
	
	// Optional methods for lifecycle management
	onFileOpen?(filePath: string): void;
	onLayoutChange?(): void;
	cleanup?(): void;

	protected log(message: string, ...args: any[]): void {
		if (this.debugMode) {
			console.log(`[${this.getName()}] ${message}`, ...args);
		}
	}
} 