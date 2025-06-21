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
		try {
			// First pass: Add anchor IDs to equations with tags
			this.addEquationAnchors(el);
			
			// Second pass: Look for MathJax containers that might be equation references
			const mathContainers = el.querySelectorAll('mjx-container.MathJax');
			
			this.log(`Processing ${mathContainers.length} MathJax containers`);
			
			// Third pass: Also look for equations in embedded PDFs or images
			this.processEmbeddedEquations(el, ctx);
			
			mathContainers.forEach((container, index) => {
				try {
					// Skip if already processed or display equation
					if (container.closest('a.equation-reference') || container.getAttribute('display') === 'true') {
						return;
					}

					const textContent = this.extractMathJaxText(container as HTMLElement);
					
					// Check various patterns for equation references
					const patterns = [
						/^\((\*?[A-Z]{0,2}\d+(?:[.\-]\d+)*[a-z]?)\)$/,                 // (4.13) or (FI7.54) or (BE3.5) or (*3.5) or (LA3.6a)
						/^Eq\.?\s*(\*?[A-Z]{0,2}\d+(?:[.\-]\d+)*[a-z]?)$/i,            // Eq. 4.13 or Eq FI7.54 or Eq. BE3.5a or Eq. *3.5
						/^Equation\s*(\*?[A-Z]{0,2}\d+(?:[.\-]\d+)*[a-z]?)$/i,         // Equation 4.13 or Equation FI7.54 or Equation BE3.5a or Equation *3.5
						/^\(Eq\.?\s*(\*?[A-Z]{0,2}\d+(?:[.\-]\d+)*[a-z]?)\)$/i,        // (Eq. 4.13) or (Eq. FI7.54) or (Eq. BE3.5a) or (Eq. *3.5)
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
				} catch (containerError) {
					this.log(`Error processing container: ${containerError}`);
					// Continue processing other containers
				}
			});
		} catch (error) {
			this.log(`Error processing equation references: ${error}`);
		}
	}

	private processEmbeddedEquations(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
		try {
			// Look for embedded PDFs that might contain equations
			const pdfEmbeds = el.querySelectorAll('iframe[src*=".pdf"], embed[src*=".pdf"], object[data*=".pdf"]');
			
			if (pdfEmbeds.length > 0) {
				this.log(`Found ${pdfEmbeds.length} embedded PDFs`);
				// Note: Extracting equations from PDFs would require additional PDF processing
				// For now, just log their presence
			}

			// Look for images that might contain equation references (screenshots, etc.)
			const images = el.querySelectorAll('img[src*="equation"], img[alt*="equation"], img[src*="eq-"]');
			
			if (images.length > 0) {
				this.log(`Found ${images.length} potential equation images`);
				// Could implement OCR or alt-text parsing here in the future
			}
		} catch (error) {
			this.log(`Error processing embedded equations: ${error}`);
		}
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
			
			// Process all labels and create anchors for each equation number
			const equationNumbers: string[] = [];
			
			labels.forEach(label => {
				const tagText = this.extractMathJaxText(label as HTMLElement);
				
				// Check if this looks like an equation tag (support prefixes and different separators)
				const tagPatterns = [
					/^\((\*?[A-Z]{0,2}\d+(?:[.\-]\d+)*[a-z]?)\)$/         // (4.13) or (FI7.54) or (BE3.5) or (*3.5) or (LA3.6a)
				];
				
				for (const tagPattern of tagPatterns) {
					const tagMatch = tagText.match(tagPattern);
					if (tagMatch) {
						const equationNumber = tagMatch[1];
						equationNumbers.push(equationNumber);
						break; // Stop after first match for this label
					}
				}
			});
			
			// If we found equation numbers, set up anchors
			if (equationNumbers.length > 0) {
				// Use the first equation number as the primary ID
				if (!equation.id) {
					equation.id = `eq-${equationNumbers[0]}`;
					this.log(`Primary anchor: eq-${equationNumbers[0]}`);
				}
				
				// For multiple equations, add data attributes for all equation numbers
				if (equationNumbers.length > 1) {
					equation.setAttribute('data-equation-numbers', equationNumbers.join(','));
					this.log(`Multiple equations in block: ${equationNumbers.join(', ')}`);
					
					// Create additional invisible spans for other equation numbers that point to the same block
					equationNumbers.slice(1).forEach(eqNum => {
						const existingAnchor = document.getElementById(`eq-${eqNum}`);
						if (!existingAnchor) {
							const anchor = document.createElement('span');
							anchor.id = `eq-${eqNum}`;
							anchor.style.cssText = 'position: absolute; visibility: hidden; pointer-events: none;';
							anchor.setAttribute('data-redirect-to', `eq-${equationNumbers[0]}`);
							
							// Insert before the equation container
							if (equation.parentNode) {
								equation.parentNode.insertBefore(anchor, equation);
							}
							this.log(`Redirect anchor: eq-${eqNum} -> eq-${equationNumbers[0]}`);
						}
					});
				}
			}
		});
	}

	private extractMathJaxText(container: HTMLElement): string {
		try {
			// Method 1: Try to get from title or data attributes first
			const title = container.getAttribute('title') || 
						 container.getAttribute('aria-label') ||
						 container.getAttribute('data-original-text');
			if (title && title.trim()) {
				return title.trim();
			}

			// Method 2: Try to reconstruct from character codes
			const chars: string[] = [];
			const mjxChars = container.querySelectorAll('mjx-c');
			
			mjxChars.forEach((mjxChar) => {
				try {
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
				} catch (charError) {
					// Skip problematic characters but continue processing
					this.log(`Warning: Failed to extract character: ${charError}`);
				}
			});

			const result = chars.join('');
			if (result) {
				return result;
			}

			// Method 3: Final fallback - try to get any text content from the container
			const fallbackText = container.textContent?.trim();
			if (fallbackText) {
				return fallbackText;
			}

			// Method 4: Last resort - check for specific MathJax structure patterns
			const mjxMath = container.querySelector('mjx-math');
			if (mjxMath) {
				const mathText = mjxMath.textContent?.trim();
				if (mathText) {
					return mathText;
				}
			}

			return '';
		} catch (error) {
			this.log(`Error extracting MathJax text: ${error}`);
			// Return empty string rather than failing completely
			return '';
		}
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
				this.scrollToEquation(equationNumber);
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

	private scrollToEquation(equationNumber: string): void {
		let target = document.getElementById(`eq-${equationNumber}`);
		
		// Check if this is a redirect anchor
		if (target && target.hasAttribute('data-redirect-to')) {
			const redirectTo = target.getAttribute('data-redirect-to');
			if (redirectTo) {
				target = document.getElementById(redirectTo);
				this.log(`Redirecting eq-${equationNumber} to ${redirectTo}`);
			}
		}
		
		if (target) {
			// Enhanced smooth scroll with better visual feedback
			target.scrollIntoView({ 
				behavior: 'smooth', 
				block: 'center',
				inline: 'nearest'
			});
			
			// Improved highlight effect with scale animation
			const originalTransition = target.style.transition;
			const originalBackground = target.style.backgroundColor;
			const originalTransform = target.style.transform;
			const originalBorderRadius = target.style.borderRadius;
			
			target.style.transition = 'all 0.3s ease';
			target.style.backgroundColor = 'var(--text-accent)';
			target.style.transform = 'scale(1.02)';
			target.style.borderRadius = '8px';
			
			setTimeout(() => {
				if (target) {
					target.style.backgroundColor = originalBackground;
					target.style.transform = originalTransform;
					target.style.borderRadius = originalBorderRadius;
					setTimeout(() => {
						if (target) {
							target.style.transition = originalTransition;
						}
					}, 300);
				}
			}, 800);
		} else {
			// Fallback: try standard anchor navigation
			this.log(`Target equation eq-${equationNumber} not found, trying standard navigation`);
			window.location.hash = `eq-${equationNumber}`;
		}
	}
}

// Alternative approach: Markdown preprocessor
export class EquationReferencesPreprocessor {
	static processMarkdown(content: string): string {
		// Pattern to match equation references like $\text{(4.13)}$, $(FI7.54)$, etc.
		const patterns = [
			/\$\\text\{(\(\*?[A-Z]{0,2}[0-9]+(?:[.\-][0-9]+)*[a-z]?\))\}\$/g,    // $\text{(4.13)}$ or $\text{(FI7.54)}$ or $\text{(*3.5)}$
			/\$(\(\*?[A-Z]{0,2}[0-9]+(?:[.\-][0-9]+)*[a-z]?\))\$/g,              // $(4.13)$ or $(FI7.54)$ or $(*3.5)$
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