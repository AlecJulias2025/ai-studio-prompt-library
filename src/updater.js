/**
 * updater.js
 * 
 * Provides the Updater class for interactively re-calibrating the DOM targets.
 * This script is loaded before content_script.js so the class is available.
 */

export class Updater {
    constructor(procedure, onComplete) {
        this.procedure = JSON.parse(JSON.stringify(procedure)); // Deep copy
        this.onComplete = onComplete;
        this.allSteps = [
            { key: 'attachLibraryButton', config: this.procedure.attachLibraryButton },
            ...Object.keys(this.procedure.steps).map(key => ({
                key,
                config: this.procedure.steps[key]
            }))
        ];
        this.currentStepIndex = 0;
        this.overlay = null;
    }

    start() {
        this.createOverlay();
        this.checkNextStep();
    }

    createOverlay() {
        if (this.overlay) this.overlay.remove();
        this.overlay = document.createElement('div');
        this.overlay.style.cssText = `
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            padding: 20px;
            background-color: rgba(0, 0, 0, 0.85);
            color: white;
            border-radius: 8px;
            z-index: 999999;
            font-family: sans-serif;
            text-align: center;
            border: 2px solid #1a73e8;
            box-shadow: 0 5px 15px rgba(0,0,0,0.5);
            max-width: 600px;
        `;
        document.body.appendChild(this.overlay);
    }

    updateOverlay(htmlContent, status = 'info') {
        const colors = {
            info: '#1a73e8',
            success: '#34a853',
            fail: '#ea4335'
        };
        this.overlay.style.borderColor = colors[status];
        this.overlay.innerHTML = htmlContent;
    }

    checkNextStep() {
        if (this.currentStepIndex >= this.allSteps.length) {
            this.finish();
            return;
        }

        const step = this.allSteps[this.currentStepIndex];
        this.updateOverlay(`<h2>Step ${this.currentStepIndex + 1}/${this.allSteps.length}: Checking...</h2><p>${step.config.description}</p>`, 'info');

        setTimeout(async () => {
            let element = document.querySelector(`[aria-label="${step.config.targetAriaLabel}"]`);
            if(!element && step.config.targetXPath) {
                try {
                    const result = document.evaluate(step.config.targetXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    if (result.singleNodeValue) element = result.singleNodeValue;
                } catch(e) {
                    console.warn(`Updater: Invalid XPath for step ${step.key}`, e);
                }
            }
            
            if (element) {
                this.handleSuccess(element);
            } else {
                this.handleFailure();
            }
        }, 1500);
    }

    handleSuccess(element) {
        element.style.outline = '3px solid #34a853';
        element.style.boxShadow = '0 0 15px #34a853';
        const step = this.allSteps[this.currentStepIndex];
        this.updateOverlay(`<h2>Step ${this.currentStepIndex + 1}/${this.allSteps.length}: SUCCESS!</h2><p>Found element for: <br/>"${step.config.description}"</p>`, 'success');
        
        setTimeout(() => {
            element.style.outline = '';
            element.style.boxShadow = '';
            this.currentStepIndex++;
            this.checkNextStep();
        }, 2500);
    }

    handleFailure() {
        const step = this.allSteps[this.currentStepIndex];
        this.updateOverlay(`
            <h2>Step ${this.currentStepIndex + 1}/${this.allSteps.length}: FAILED</h2>
            <p>Could not find element for:<br/><em>"${step.config.description}"</em></p>
            <p style="font-weight: bold; font-size: 1.2em; color: #ffdd57;">Please CLICK the correct element on the page now.</p>
        `, 'fail');
        this.awaitUserClick();
    }
    
    generateXPath(element) {
        if (element.id) {
            return `id("${element.id}")`;
        }
        if (element === document.body) {
            return element.tagName.toLowerCase();
        }
    
        let ix = 0;
        const siblings = element.parentNode.childNodes;
        for (let i = 0; i < siblings.length; i++) {
            const sibling = siblings[i];
            if (sibling === element) {
                return `${this.generateXPath(element.parentNode)}/${element.tagName.toLowerCase()}[${ix + 1}]`;
            }
            if (sibling.nodeType === 1 && sibling.tagName === element.tagName) {
                ix++;
            }
        }
        // This line should technically be unreachable
        return null; 
    }
    
    clickHandler = (event) => {
        event.preventDefault();
        event.stopPropagation();

        document.body.removeEventListener('click', this.clickHandler, true);
        
        const clickedElement = event.target;
        const newAriaLabel = clickedElement.getAttribute('aria-label');
        const newXPath = this.generateXPath(clickedElement);

        const stepToUpdate = this.allSteps[this.currentStepIndex];

        if(stepToUpdate.key === 'attachLibraryButton') {
            this.procedure.attachLibraryButton.targetAriaLabel = newAriaLabel || '';
            this.procedure.attachLibraryButton.targetXPath = newXPath;
        } else {
            this.procedure.steps[stepToUpdate.key].targetAriaLabel = newAriaLabel || '';
            this.procedure.steps[stepToUpdate.key].targetXPath = newXPath;
        }

        console.log(`Updated step '${stepToUpdate.key}' with new targets:`, { ariaLabel: newAriaLabel, xpath: newXPath });
        this.updateOverlay('<h2>Target Updated!</h2><p>Thank you. Re-validating the step...</p>', 'success');
        
        // Refresh the local steps array to reflect the change before re-checking
        this.allSteps = [
            { key: 'attachLibraryButton', config: this.procedure.attachLibraryButton },
            ...Object.keys(this.procedure.steps).map(key => ({
                key,
                config: this.procedure.steps[key]
            }))
        ];
        
        setTimeout(() => this.checkNextStep(), 1500);
    }

    awaitUserClick() {
        document.body.addEventListener('click', this.clickHandler, { capture: true });
    }

    finish() {
        this.updateOverlay('<h2>Calibration Complete!</h2><p>All steps have been successfully configured. The new configuration has been saved. The page will now reload.</p>', 'success');
        this.onComplete(this.procedure);
        setTimeout(() => {
            location.reload();
        }, 4000);
    }
}
