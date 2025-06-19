import { App, MarkdownPostProcessorContext } from 'obsidian';
import { BaseFeature, FeatureSettings } from './base-feature';

interface EquationReferencesSettings extends FeatureSettings {
	enableEquationReferences: boolean;
}

export class EquationReferencesFeature extends BaseFeature {
	private app: App;

	constructor(app: App, debugMode: boolean = false) {
		super(debugMode);
		this.app = app;
	}

	getName(): string {
		return 'EquationReferences';
	}

	isEnabled(settings: EquationReferencesSettings): boolean {
		return settings.enableEquationReferences;
	}

	async process(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
		// Wait a bit for MathJax to render, then process equation references
		setTimeout(() => {
			this.processRenderedEquationReferences(el, ctx);
		}, 200);
	}

	private processRenderedEquationReferences(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
		// First pass: Add anchor IDs to equations with tags
		this.addEquationAnchors(el);
		
		// Second pass: Look for MathJax containers that might be equation references
		const mathContainers = el.querySelectorAll('mjx-container.MathJax');
		
		this.log(`Processing ${mathContainers.length} MathJax containers`);
		
		mathContainers.forEach((container, index) => {
			// Skip if already processed or display equation
			if (container.closest('a.equation-reference') || container.getAttribute('display') === 'true') {
				return;
			}

			const textContent = this.extractMathJaxText(container as HTMLElement);
			
			// Check various patterns for equation references
			const patterns = [
				/^\((\d+(?:\.\d+)*)\)$/,          // (4.13)
				/^Eq\.?\s*(\d+(?:\.\d+)*)$/i,     // Eq. 4.13 or Eq 4.13
				/^Equation\s*(\d+(?:\.\d+)*)$/i,  // Equation 4.13
				/^\(Eq\.?\s*(\d+(?:\.\d+)*)\)$/i, // (Eq. 4.13)
			];

			for (const pattern of patterns) {
				const refMatch = textContent.match(pattern);
				if (refMatch) {
					const equationNumber = refMatch[1];
					this.log(`Ref: "${textContent}" → eq-${equationNumber}`);
					
					// Convert to clickable link
					this.convertToEquationLink(container as HTMLElement, equationNumber, ctx);
					break; // Stop after first match
				}
			}
		});
	}

	private addEquationAnchors(el: HTMLElement): void {
		// Look for display equations with labels (tags)
		const displayEquations = el.querySelectorAll('mjx-container.MathJax[display="true"]');
		
		if (displayEquations.length > 0) {
			this.log(`Found ${displayEquations.length} display equations`);
		}
		
		displayEquations.forEach((equation, index) => {
			// Check if this equation has a label/tag
			const labels = equation.querySelectorAll('mjx-labels mjx-mtext');
			
			labels.forEach(label => {
				const tagText = this.extractMathJaxText(label as HTMLElement);
				
				// Check if this looks like an equation tag
				const tagMatch = tagText.match(/^\((\d+(?:\.\d+)*)\)$/);
				if (tagMatch) {
					const equationNumber = tagMatch[1];
					const anchorId = `eq-${equationNumber}`;
					
					// Add HTML anchor ID (this actually works!)
					if (!equation.id) {
						equation.id = anchorId;
						this.log(`Anchor: eq-${equationNumber}`);
					}
				}
			});
		});
	}

	private extractMathJaxText(container: HTMLElement): string {
		// Method 1: Try to get from title or data attributes first
		const title = container.getAttribute('title') || 
					 container.getAttribute('aria-label') ||
					 container.getAttribute('data-original-text');
		if (title) {
			return title;
		}

		// Method 2: Try to reconstruct from character codes
		const chars: string[] = [];
		const mjxChars = container.querySelectorAll('mjx-c');
		
		mjxChars.forEach((mjxChar) => {
			const classList = Array.from(mjxChar.classList);
			
			// Look for class that starts with 'mjx-c' and has more characters (the hex code)
			const charClass = classList.find(cls => cls.startsWith('mjx-c') && cls.length > 5);
			
			if (charClass) {
				const hexCode = charClass.substring(5); // Remove 'mjx-c' prefix
				const charCode = parseInt(hexCode, 16);
				
				if (!isNaN(charCode) && charCode > 0) {
					const char = String.fromCharCode(charCode);
					chars.push(char);
				}
			} else {
				// Fallback: try to get text content directly
				const textContent = mjxChar.textContent?.trim();
				if (textContent) {
					chars.push(textContent);
				}
			}
		});

		return chars.join('');
	}

	private convertToEquationLink(container: HTMLElement, equationNumber: string, ctx: MarkdownPostProcessorContext): void {
		try {
			// Check if already wrapped in a link
			if (container.closest('a')) {
				return;
			}

			// Create a link element with custom styling
			const link = document.createElement('a');
			link.href = `#eq-${equationNumber}`;
			link.className = 'equation-reference';
			link.setAttribute('data-equation-number', equationNumber);
			
			// Add smooth scrolling behavior
			link.addEventListener('click', (e) => {
				e.preventDefault();
				const target = document.getElementById(`eq-${equationNumber}`);
				if (target) {
					target.scrollIntoView({ behavior: 'smooth', block: 'center' });
					// Add a brief highlight effect
					target.style.transition = 'background-color 0.3s ease';
					target.style.backgroundColor = 'var(--background-modifier-hover)';
					setTimeout(() => {
						target.style.backgroundColor = '';
					}, 1000);
				}
			});

			// Clone the container and wrap it
			const clone = container.cloneNode(true) as HTMLElement;
			link.appendChild(clone);
			
			// Replace the original container
			if (container.parentNode) {
				container.parentNode.replaceChild(link, container);
			}

		} catch (error) {
			this.log(`Error: ${error}`);
		}
	}
}

// Alternative approach: Markdown preprocessor
export class EquationReferencesPreprocessor {
	static processMarkdown(content: string): string {
		// Pattern to match equation references like $\text{(4.13)}$ or $(4.13)$
		const patterns = [
			/\$\\text\{(\([0-9]+(?:\.[0-9]+)*\))\}\$/g,  // $\text{(4.13)}$
			/\$(\([0-9]+(?:\.[0-9]+)*\))\$/g,            // $(4.13)$
		];

		let processedContent = content;
		
		patterns.forEach(pattern => {
			processedContent = processedContent.replace(pattern, (match, equationRef) => {
				// Extract just the number part (remove parentheses)
				const numberMatch = equationRef.match(/\(([0-9]+(?:\.[0-9]+)*)\)/);
				if (numberMatch) {
					const eqNumber = numberMatch[1];
					// Replace with HTML link that won't be processed by MathJax
					return `<a href="#^eq-${eqNumber}" class="equation-reference">${equationRef}</a>`;
				}
				return match;
			});
		});

		return processedContent;
	}
} 