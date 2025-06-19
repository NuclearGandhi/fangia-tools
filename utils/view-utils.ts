import { App } from 'obsidian';

export class ViewUtils {
	static isReadingView(app: App): boolean {
		const activeLeaf = app.workspace.activeLeaf;
		if (!activeLeaf || activeLeaf.view.getViewType() !== 'markdown') {
			return false;
		}
		
		// Check if the view has a reading mode (preview mode)
		const markdownView = activeLeaf.view as any;
		return markdownView.getMode && markdownView.getMode() === 'preview';
	}

	static getCurrentViewMode(app: App): string | null {
		const activeLeaf = app.workspace.activeLeaf;
		if (!activeLeaf || activeLeaf.view.getViewType() !== 'markdown') {
			return null;
		}
		const markdownView = activeLeaf.view as any;
		return markdownView.getMode && markdownView.getMode();
	}

	static shouldSkipElement(el: HTMLElement): boolean {
		return el.classList.contains('mod-frontmatter') || 
			   el.classList.contains('mod-header') ||
			   el.tagName === 'PRE' ||
			   el.classList.contains('frontmatter');
	}
} 