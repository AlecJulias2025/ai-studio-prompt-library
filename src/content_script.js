/**
 * content_script.js
 *
 * This is the main script injected into the AI Studio page.
 *
 * Responsibilities:
 * - Initializes and manages the self-updating procedure from `procedure.json`.
 * - Injects the "Instructions Library" button onto the page.
 * - Creates a Shadow DOM to host the library UI, preventing CSS conflicts.
 * - Fetches cached prompts from storage and populates the library UI.
 * - Executes the procedure steps (clicking buttons, pasting text) when a user selects a prompt.
 * - Listens for the user to start the "Updater Mode" and hands control over to the Updater module.
 */

// Use an IIFE to avoid polluting the global scope of the host page.
(async function() {
  const PROCEDURE_KEY = 'procedureConfiguration';
  const BASE_PROMPT_CACHE_KEY = 'basePromptCache';
  const USER_PROMPT_CACHE_KEY = 'userPromptCache';

  // --- Default Configuration: This will be used on first run ---
  const DEFAULT_PROCEDURE = {
    attachLibraryButton: {
      description: "Attach the 'Instructions Library' button relative to the 'Send a message' input area.",
      targetAriaLabel: 'Send a message',
      targetXPath: '//*[@aria-label="Send a message"]',
      position: 'beforebegin' // 'beforebegin', 'afterbegin', 'beforeend', 'afterend'
    },
    steps: {
      openSystemInstructions: {
        description: "Click the 'System instructions' button to open the editing modal.",
        targetAriaLabel: 'System instructions',
        targetXPath: '//*[@aria-label="System instructions"]',
        waitForElement: false
      },
      pasteIntoTextarea: {
        description: "Find the main textarea within the modal and paste the instructions.",
        targetAriaLabel: 'Edit system instructions',
        targetXPath: '//*[@aria-label="Edit system instructions"]',
        waitForElement: true
      },
      saveAndClose: {
        description: "Click the 'Save' button to confirm changes and close the modal.",
        targetAriaLabel: 'Save',
        targetXPath: '//*[@aria-label="Save"]',
        waitForElement: true
      }
    }
  };

  let procedure;
  let shadowRoot;
  let libraryVisible = false;

  /**
   * Waits for a specific element to appear in the DOM.
   * Uses MutationObserver for efficiency. Rejects after a timeout.
   * @param {string} ariaLabel - The aria-label to query for.
   * @param {string} xpath - The XPath to query for as a fallback.
   * @param {number} timeout - Maximum time to wait in ms.
   * @returns {Promise<Element>} - Resolves with the found element.
   */
  function waitForElement(ariaLabel, xpath, timeout = 10000) {
    return new Promise((resolve, reject) => {
      // First, try a direct query in case the element is already there.
      let element = document.querySelector(`[aria-label="${ariaLabel}"]`);
      if (element) return resolve(element);
      
      // If XPath is available, try it as well.
      if (!element && xpath) {
         try {
           const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
           if (result.singleNodeValue) return resolve(result.singleNodeValue);
         } catch(e){ console.warn("Invalid XPath provided:", xpath, e)}
      }

      const observer = new MutationObserver((mutations, obs) => {
        element = document.querySelector(`[aria-label="${ariaLabel}"]`);
         if (!element && xpath) {
           try {
              const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
              if(result.singleNodeValue) element = result.singleNodeValue;
           } catch(e){/* ignore */}
         }

        if (element) {
          obs.disconnect();
          clearTimeout(timer);
          resolve(element);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Element with aria-label "${ariaLabel}" or XPath not found after ${timeout}ms.`));
      }, timeout);
    });
  }

  /**
   * Executes the entire procedure to load a prompt into the UI.
   * @param {string} instructions - The system instructions text to paste.
   */
  async function executeProcedure(instructions) {
    console.log("Executing procedure...");
    toggleLibraryUI(false); // Hide the library

    try {
      const openStep = procedure.steps.openSystemInstructions;
      const openButton = await waitForElement(openStep.targetAriaLabel, openStep.targetXPath);
      openButton.click();
      console.log("Step 1/3: Opened system instructions.");

      const pasteStep = procedure.steps.pasteIntoTextarea;
      const textarea = await waitForElement(pasteStep.targetAriaLabel, pasteStep.targetXPath);
      textarea.value = instructions;
      // Dispatch input event to ensure frameworks like React/Angular recognize the change.
      textarea.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      console.log("Step 2/3: Pasted instructions into textarea.");

      const saveStep = procedure.steps.saveAndClose;
      const saveButton = await waitForElement(saveStep.targetAriaLabel, saveStep.targetXPath);
      saveButton.click();
      console.log("Step 3/3: Saved and closed. Procedure complete.");

    } catch (error) {
      alert(`An error occurred during the procedure:\n${error.message}\n\nPlease run the Updater Mode to re-calibrate the extension.`);
      console.error("Procedure failed:", error);
    }
  }

  /**
   * Parses the raw text of a prompt file into a structured object.
   * Adheres strictly to the specified string manipulation method.
   * @param {string} rawText - The raw text from the prompt file.
   * @param {number} index - The index of the prompt in the list, used for ID generation.
   * @returns {object|null} - An object with { id, markdown, instructions } or null if parsing fails.
   */
  function parsePromptText(rawText, index) {
      const id = `SI-${String(index + 1).padStart(3, '0')}`;
      const beforeMarker = "~~####PROMPT_BEFORE####~~";
      const sysMarker = "~~####SYSTEM_INSTRUCTIONS####~~";
      const afterMarker = "~~####PROMPT_AFTER####~~";
  
      const beforeIndex = rawText.indexOf(beforeMarker);
      const sysIndex = rawText.indexOf(sysMarker);
      const afterIndex = rawText.indexOf(afterMarker);
  
      if (beforeIndex === -1 || sysIndex === -1 || afterIndex === -1) {
          console.warn(`Could not parse prompt at index ${index}. Missing markers.`);
          return null;
      }
  
      const markdown = rawText.substring(beforeIndex + beforeMarker.length, sysIndex).trim();
      const instructions = rawText.substring(sysIndex + sysMarker.length, afterIndex).trim();
  
      return { id, markdown, instructions };
  }


  /**
   * Fetches the cached prompts and populates the library UI list.
   */
  async function populateLibrary() {
    if (!shadowRoot) return;

    const listContainer = shadowRoot.getElementById('prompt-list');
    const previewContainer = shadowRoot.getElementById('prompt-preview');
    if (!listContainer || !previewContainer) return;
    listContainer.innerHTML = 'Loading...';

    const data = await browser.storage.local.get([BASE_PROMPT_CACHE_KEY, USER_PROMPT_CACHE_KEY]);
    const basePrompts = data[BASE_PROMPT_CACHE_KEY] || [];
    const userPrompts = data[USER_PROMPT_CACHE_KEY] || [];
    const prompts = [...basePrompts, ...userPrompts];
    listContainer.innerHTML = '';

    if (prompts.length === 0) {
      listContainer.innerHTML = '<li class="prompt-item">No prompts found. Check the extension options to add sources.</li>';
      return;
    }

    const parsedPrompts = prompts.map(parsePromptText).filter(p => p !== null);

    parsedPrompts.forEach(prompt => {
      const listItem = document.createElement('div');
      listItem.className = 'prompt-item';
      listItem.textContent = prompt.id + " - " + (prompt.markdown.split('\n').replace('#', '').trim() || 'Untitled Prompt');
      listItem.dataset.promptId = prompt.id;
      
      listItem.addEventListener('mouseenter', () => {
         // Naive markdown to HTML for preview
         const basicHtml = prompt.markdown
           .replace(/^#\s(.+)/gm, '<h1>$1</h1>')
           .replace(/^##\s(.+)/gm, '<h2>$1</h2>')
           .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
           .replace(/\n/g, '<br>');
        previewContainer.innerHTML = basicHtml;
      });

      listItem.addEventListener('click', () => {
        executeProcedure(prompt.instructions);
      });
      
      listContainer.appendChild(listItem);
    });
  }

  /**
   * Toggles the visibility of the library panel. Creates it on first open.
   * @param {boolean} [forceState] - Optional: true to show, false to hide.
   */
  async function toggleLibraryUI(forceState) {
    libraryVisible = (forceState !== undefined) ? forceState : !libraryVisible;
    const container = document.getElementById('prompt-library-container');
    if (!container) return;
    
    container.style.display = libraryVisible ? 'block' : 'none';

    if (libraryVisible && !shadowRoot) {
      // First time opening: fetch and inject the UI from HTML/CSS files
      try {
        shadowRoot = container.attachShadow({ mode: 'open' });
        
        const [htmlResponse, cssResponse] = await Promise.all([
            fetch(browser.runtime.getURL('library_ui.html')),
            fetch(browser.runtime.getURL('library_ui.css'))
        ]);
        
        const html = await htmlResponse.text();
        const css = await cssResponse.text();
        
        shadowRoot.innerHTML = `
          <style>${css}</style>
          ${html}
        `;

        // Add event listeners to controls inside the Shadow DOM
        shadowRoot.getElementById('close-library-btn').addEventListener('click', () => toggleLibraryUI(false));
        shadowRoot.getElementById('updater-mode-btn').addEventListener('click', startUpdaterMode);
        
        // TODO: Add a theme toggle button that adds/removes a 'dark' class to #library-wrapper
        // document.documentElement.classList.contains('dark-theme-enabled') might check host page theme
        
        populateLibrary();
        
      } catch (error) {
        console.error("Failed to load library UI:", error);
        container.textContent = "Error loading UI.";
      }
    } else if (libraryVisible) {
        // Refresh library content every time it's opened in case of updates.
        populateLibrary();
    }
  }
  
  /**
   * Starts the updater mode process.
   */
  function startUpdaterMode() {
    toggleLibraryUI(false);
    alert("Updater Mode will now begin. The page will reload.\n\nPlease follow the on-screen instructions to re-calibrate the extension.");
    // Use storage to signal the updater mode should start after reload.
    browser.storage.local.set({ 'startUpdaterMode': true }).then(() => {
        location.reload();
    });
  }

  /**
   * Finds the attachment point and injects the main library button and container.
   */
  async function injectLibraryButton() {
    try {
      const attachConfig = procedure.attachLibraryButton;
      const attachPoint = await waitForElement(attachConfig.targetAriaLabel, attachConfig.targetXPath, 15000);

      const button = document.createElement('button');
      button.id = 'prompt-library-btn';
      button.textContent = '📕 Instructions Library';
      button.style.cssText = `
        background-color: #1a73e8; color: white; border: none; padding: 8px 12px;
        margin: 0 10px; border-radius: 4px; cursor: pointer; font-size: 14px;
        font-weight: 500;
      `;
      button.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          toggleLibraryUI();
      });
      
      const libraryContainer = document.createElement('div');
      libraryContainer.id = 'prompt-library-container';
      libraryContainer.style.display = 'none';
      
      attachPoint.insertAdjacentElement(attachConfig.position, libraryContainer);
      attachPoint.insertAdjacentElement(attachConfig.position, button);

      // We attach the library UI container at the same time for simplicity.
    } catch (error) {
      console.error('Failed to inject library button:', error);
      alert('Forge: Could not find the anchor element to attach the library button. Please run the Updater Mode from the extension\'s options page to fix this.');
    }
  }

  /**
   * Main initialization function for the content script.
   */
  async function init() {
    const shouldStartUpdater = await browser.storage.local.get('startUpdaterMode');
    if(shouldStartUpdater.startUpdaterMode) {
        await browser.storage.local.remove('startUpdaterMode');
        const updaterConfig = await browser.storage.local.get(PROCEDURE_KEY);
        procedure = updaterConfig[PROCEDURE_KEY] || DEFAULT_PROCEDURE;
        // The Updater class is available globally from updater.js
        const updater = new Updater(procedure, (newProcedure) => {
            browser.storage.local.set({ [PROCEDURE_KEY]: newProcedure });
        });
        updater.start();
        return;
    }
    
    const storedProcedure = await browser.storage.local.get(PROCEDURE_KEY);
    if (!storedProcedure[PROCEDURE_KEY]) {
      console.log('No procedure found, initializing with default.');
      await browser.storage.local.set({ [PROCEDURE_KEY]: DEFAULT_PROCEDURE });
      procedure = DEFAULT_PROCEDURE;
    } else {
      procedure = storedProcedure[PROCEDURE_KEY];
    }

    injectLibraryButton();
  }
  
  // A small delay to let the host application render.
  if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
  } else {
      setTimeout(init, 500);
  }

})();
