/**
 * content_script.js
 *
 * This is the main script injected into the AI Studio page.
 * V2.0 - Refactored to use npm modules and an event bus for clean architecture.
 */
import autoAnimate from '@formkit/auto-animate';
import { marked } from 'marked';
import { Updater } from './updater.js';
import { bus } from './event_bus.js';
import { parse as parseAetherflow } from './aetherflow_parser.js';

// Use an IIFE to avoid polluting the global scope of the host page.
(async function() {
  const PROCEDURE_KEY = 'procedureConfiguration';
  const BASE_PROMPT_CACHE_KEY = 'basePromptCache';
  const USER_PROMPT_CACHE_KEY = 'userPromptCache';

  // --- Default Configuration: This will be used on first run ---
  const DEFAULT_PROCEDURE = {
    attachLibraryButton: {
      description: "Attach the 'Instructions Library' button relative to the prompt input area.",
      targetAriaLabel: "Start typing a prompt",
      targetXPath: "//*[@aria-label='Start typing a prompt']",
      position: "beforebegin"
    },
    steps: {
      openSystemInstructions: {
        description: "Click the 'System instructions' button to open the editing modal.",
        targetAriaLabel: "System instructions",
        targetXPath: "//*[@aria-label='System instructions']",
        waitForElement: false
      },
      pasteIntoTextarea: {
        description: "Find the main textarea within the modal and paste the instructions.",
        targetAriaLabel: "System instructions",
        targetXPath: "//*[@aria-label='System instructions']",
        waitForElement: true
      },
      closePanel: {
        description: "Click the 'Close panel' button to confirm changes.",
        targetAriaLabel: "Close panel",
        targetXPath: "//*[@aria-label='Close panel']",
        waitForElement: true
      }
    },
    chatHistorySelectors: {
      conversationContainer: "ms-autoscroll-container",
      messageTurnContainer: ".chat-turn-container",
      authorIdentification: {
        user: "[data-turn-role='User'] .very-large-text-container",
        ai: {
          chat: "[data-turn-role='Model'] > .turn-content > ms-prompt-chunk:not(:has(ms-thought-chunk)) .very-large-text-container",
          thoughts: "[data-turn-role='Model'] ms-thought-chunk .very-large-text-container"
        }
      }
    },
    promptSubmission: {
      inputArea: "textarea[aria-label='Start typing a prompt']",
      submitButton: "button[aria-label='Run']"
    }
  };

  let procedure;
  let shadowRoot;
  let libraryVisible = false;

  /**
   * Waits for a specific element to appear in the DOM.
   * Uses MutationObserver for efficiency. Rejects after a timeout.
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

      const closeStep = procedure.steps.closePanel;
      const closeButton = await waitForElement(closeStep.targetAriaLabel, closeStep.targetXPath);
      closeButton.click();
      console.log("Step 3/3: Closed panel. Procedure complete.");

    } catch (error) {
      alert(`An error occurred during the procedure:\n${error.message}\n\nPlease run the Updater Mode to re-calibrate the extension.`);
      console.error("Procedure failed:", error);
    }
  }

  /**
   * Parses the raw text of a prompt file into a structured object.
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
    listContainer.innerHTML = ''; // Clear for auto-animation

    if (prompts.length === 0) {
      listContainer.innerHTML = '<li class="prompt-item">No prompts found. Check options.</li>';
      return;
    }

    const parsedPrompts = prompts.map(parsePromptText).filter(p => p !== null);

    parsedPrompts.forEach((prompt, index) => {
      const listItem = document.createElement('div');
      listItem.className = 'prompt-item';
      listItem.textContent = prompt.id + " - " + (prompt.markdown.split('\n')[0].replace('#', '').trim() || 'Untitled Prompt');
      listItem.dataset.promptId = prompt.id;
      
      listItem.addEventListener('mouseenter', () => {
        // [UPGRADE COMPLETE] Use 'marked' for rich HTML preview
        previewContainer.innerHTML = marked.parse(prompt.markdown, { sanitize: true });
      });

      listItem.addEventListener('click', () => {
        // [UPGRADE COMPLETE] Emit a 'loadPrompt' signal instead of direct call
        bus.emit('loadPrompt', prompt);
      });
      
      listContainer.appendChild(listItem);
    });
  }

  /**
   * Toggles the visibility of the library panel. Creates it on first open.
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
            fetch(browser.runtime.getURL('src/library_ui.html')),
            fetch(browser.runtime.getURL('src/library_ui.css'))
        ]);
        
        const html = await htmlResponse.text();
        const css = await cssResponse.text();
        
        shadowRoot.innerHTML = `
          <style>${css}</style>
          ${html}
        `;

        // --- UPGRADE IMPLEMENTATIONS ---

        // 1. Attach listeners that emit signals via the event bus
        shadowRoot.getElementById('close-library-btn').addEventListener('click', () => toggleLibraryUI(false));
        shadowRoot.getElementById('updater-mode-btn').addEventListener('click', () => {
          bus.emit('startUpdater'); // [UPGRADE COMPLETE]
        });

        // 2. Attach auto-animate to the list containers for smooth transitions
        const listContainer = shadowRoot.getElementById('prompt-list');
        const logList = shadowRoot.getElementById('aetherflow-log-list');
        if (listContainer) autoAnimate(listContainer);
        if (logList) autoAnimate(logList); // [UPGRADE COMPLETE]
        
        populateLibrary();
        
      } catch (error) {
        console.error("Failed to load library UI:", error);
        container.textContent = "Error loading UI.";
       }
    } else if (libraryVisible) {
        populateLibrary();
    }
  }

  /**
   * Updates the Aetherflow status panel with a new log message.
   */
  function updateAetherflowStatus(type, data) {
    if (!shadowRoot) return;
    const panel = shadowRoot.getElementById('aetherflow-status-panel');
    const logList = shadowRoot.getElementById('aetherflow-log-list');
    if (!panel || !logList) return;

    panel.style.display = 'block';

    const li = document.createElement('li');
    let message = `[${type}]`;

    // Add specific details based on the event type
    if (data?.content) message += `: ${data.content}`;
    if (data?.link) message += `: Resolving ${data.link}`;
    if (data?.alias) message += `: Mounting ${data.alias}`;
    if (data?.error) {
        li.className = 'error';
        message += `: FAILED - ${data.error}`;
    } else if (type.includes(':success')) {
        li.className = 'success';
    }

    li.textContent = message;
    logList.appendChild(li);
    logList.scrollTop = logList.scrollHeight; // Auto-scroll to bottom
  }
  
  /**
   * Starts the updater mode process.
   */
  function startUpdaterMode() {
    toggleLibraryUI(false);
    alert("Updater Mode will now begin. The page will reload...");
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
   * Intercepts the primary "Send" button click to process Aetherflow syntax.
   */
  async function interceptSendAction() {
    try {
      const submitButtonSelector = procedure.promptSubmission.submitButton;
      const inputAreaSelector = procedure.promptSubmission.inputArea;

      const submitButton = await waitForElement('Run', "//*[@aria-label='Run']");
      if (!submitButton) {
        console.error("Aetherflow Interceptor: Could not find the submit button.");
        return;
      }

      submitButton.addEventListener('click', async (event) => {
        const inputArea = document.querySelector(inputAreaSelector);
        if (!inputArea) return;

        const rawText = inputArea.value;

        if (rawText.includes('~{{~')) {
          console.log('Aetherflow: Syntax detected, intercepting send action.');
          event.preventDefault();
          event.stopPropagation();

          try {
            submitButton.disabled = true;
            const cleanText = await parseAetherflow(rawText, procedure);
            inputArea.value = cleanText;
            inputArea.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));

            // Re-dispatch a clean click.
            submitButton.click();

          } catch (error) {
            console.error("Aetherflow: Error during parsing:", error);
            alert(`Aetherflow Engine Error:\n\n${error.message}`);
          } finally {
            submitButton.disabled = false;
          }
        }
      }, { capture: true });

      console.log("Aetherflow Interceptor: Attached to send button.");

    } catch (error) {
      console.error("Aetherflow: Failed to initialize send interceptor.", error);
    }
  }

  /**
   * Main initialization function for the content script.
   */
  async function init() {
    // --- Aetherflow Event Listeners ---
    bus.on('aetherflow:start', () => {
      if (shadowRoot) {
        shadowRoot.getElementById('aetherflow-log-list').innerHTML = '';
        updateAetherflowStatus('aetherflow:start');
      }
    });
    bus.on('aetherflow:complete', () => updateAetherflowStatus('aetherflow:complete'));
    bus.on('aetherflow:error', (e) => updateAetherflowStatus('aetherflow:error', e));
    bus.on('conduit:mount:start', (e) => updateAetherflowStatus('conduit:mount:start', e));
    bus.on('conduit:mount:success', (e) => updateAetherflowStatus('conduit:mount:success', e));
    bus.on('conduit:mount:fail', (e) => updateAetherflowStatus('conduit:mount:fail', e));
    bus.on('link:resolve:start', (e) => updateAetherflowStatus('link:resolve:start', e));
    bus.on('link:resolve:success', (e) => updateAetherflowStatus('link:resolve:success', e));
    bus.on('link:resolve:fail', (e) => updateAetherflowStatus('link:resolve:fail', e));
    bus.on('portal:action:start', (e) => updateAetherflowStatus('portal:action:start', e));
    bus.on('portal:action:success', (e) => updateAetherflowStatus('portal:action:success', e));
    bus.on('portal:action:fail', (e) => updateAetherflowStatus('portal:action:fail', e));
    bus.on('portal:resolve:start', (e) => updateAetherflowStatus('portal:resolve:start', e));
    bus.on('portal:resolve:success', (e) => updateAetherflowStatus('portal:resolve:success', e));
    bus.on('portal:resolve:fail', (e) => updateAetherflowStatus('portal:resolve:fail', e));


    // --- UI Event Listeners ---
    bus.on('loadPrompt', prompt => executeProcedure(prompt.instructions));
    bus.on('startUpdater', () => startUpdaterMode());

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
    interceptSendAction();
  }
  
  // A small delay to let the host application render.
  if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
  } else {
      setTimeout(init, 500);
  }

})();
