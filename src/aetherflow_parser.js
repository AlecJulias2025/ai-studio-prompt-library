/**
 * aetherflow_parser.js
 *
 * The core engine for parsing and executing Aetherflow scripting syntax.
 * This module is responsible for recursively resolving all Aetherflow commands
 * into a final, clean string to be sent to the AI.
 */

import { sessionMemory, conversationHistory, conduits } from './aetherflow_state.js';
import { bus } from './event_bus.js';

let _conversationScraped = false; // Memoization flag for the current conversation scraper

// --- Main Export ---

/**
 * Parses a raw text string containing Aetherflow syntax and resolves it.
 * @param {string} rawText - The user's input text.
 * @param {object} procedure - The procedure configuration with DOM selectors.
 * @returns {Promise<string>} - A promise that resolves to the final, clean text.
 */
export async function parse(rawText, procedure) {
  bus.emit('aetherflow:start');
  try {
    console.log('Aetherflow: Parsing started.');
    _conversationScraped = false; // Reset memoization flag for each new parse

    const textAfterMounts = await resolveConduits(rawText, procedure);
    await scrapeCurrentConversation(procedure);
    const finalText = await resolvePortals(textAfterMounts, procedure);

    console.log('Aetherflow: Parsing complete.');
    bus.emit('aetherflow:complete', { result: finalText });
    return finalText;
  } catch (error) {
    bus.emit('aetherflow:error', { error: error.message });
    throw error; // Re-throw to be caught by the UI interceptor
  }
}

// --- Scaffolding for Core Logic ---

/**
 * Scans for and resolves `#> mount` directives from the text.
 * @param {string} text - The input text.
 * @param {object} procedure - The procedure configuration.
 * @returns {Promise<string>} - Text with mount directives removed after processing.
 */
async function resolveConduits(text, procedure) {
    const mountRegex = /^#>\s*mount\['([^']*)'\]\s*from\s*'([^']*)'/gm;
    const mountPromises = [];
    let match;

    while ((match = mountRegex.exec(text)) !== null) {
        const alias = match[1];
        const chatUID = match[2];
        mountPromises.push(mountConduit(alias, chatUID, procedure));
    }

    await Promise.all(mountPromises);
    return text.replace(mountRegex, '').trim();
}

/**
 * Creates a hidden iframe to scrape a conversation and mounts it into the conduits store.
 * @param {string} alias - The alias for the mounted conversation.
 * @param {string} chatUID - The UID of the chat to load.
 * @param {object} procedure - The procedure configuration.
 */
async function mountConduit(alias, chatUID, procedure) {
    bus.emit('conduit:mount:start', { alias, chatUID });
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';

    try {
        await new Promise((resolve, reject) => {
            iframe.onload = () => {
                try {
                    const selectors = procedure.chatHistorySelectors;
                    const history = scrapeConversationFromDoc(iframe.contentDocument, selectors);
                    conduits.setKey(alias, history);
                    bus.emit('conduit:mount:success', { alias, turnCount: history.length });
                    console.log(`Aetherflow: Successfully mounted Conduit '${alias}' with ${history.length} turns.`);
                    resolve();
                } catch (scrapeError) {
                    reject(scrapeError);
                }
            };
            iframe.onerror = () => reject(new Error(`Iframe failed to load for chat UID: ${chatUID}`));
            iframe.src = `https://aistudio.google.com/chat/${chatUID}`;
            document.body.appendChild(iframe);
        });
    } catch (error) {
        bus.emit('conduit:mount:fail', { alias, error: error.message });
        console.error(`Aetherflow: Failed to mount Conduit '${alias}'.`, error);
    } finally {
        iframe.remove();
    }
}


/**
 * Generic function to scrape a conversation from a given document object.
 * @param {Document} doc - The document object (e.g., `document` or `iframe.contentDocument`).
 * @param {object} selectors - The chat history selectors from the procedure.
 * @returns {Array} - The scraped conversation history.
 */
function scrapeConversationFromDoc(doc, selectors) {
    if (!selectors) {
        throw new Error("Aetherflow Scraper: chatHistorySelectors not found.");
    }

    const history = [];
    const messageTurnElements = doc.querySelectorAll(selectors.messageTurnContainer);

    messageTurnElements.forEach(turnEl => {
        const userEl = turnEl.querySelector(selectors.authorIdentification.user);
        if (userEl) {
            history.push({ author: 'user', content: userEl.textContent.trim() });
            return;
        }

        const aiChatEl = turnEl.querySelector(selectors.authorIdentification.ai.chat);
        const aiThoughtsEl = turnEl.querySelector(selectors.authorIdentification.ai.thoughts);
        if (aiChatEl || aiThoughtsEl) {
            history.push({
                author: 'ai',
                chat: aiChatEl ? aiChatEl.textContent.trim() : '',
                thoughts: aiThoughtsEl ? aiThoughtsEl.textContent.trim() : ''
            });
        }
    });
    return history;
}


/**
 * Scrapes the current page's DOM to populate the conversationHistory store.
 * Implements a memoization strategy to avoid redundant scraping.
 * @param {object} procedure - The procedure configuration with DOM selectors.
 */
async function scrapeCurrentConversation(procedure) {
  if (_conversationScraped) {
    console.log('Aetherflow: Conversation history already scraped (memoized).');
    return;
  }

  try {
    const history = scrapeConversationFromDoc(document, procedure.chatHistorySelectors);
    conversationHistory.set(history);
    _conversationScraped = true;
    console.log(`Aetherflow: Scraped ${history.length} conversation turns.`);
  } catch(error){
     console.error("Aetherflow: Failed to scrape current conversation.", error);
  }
}

const BASE_PROMPT_CACHE_KEY = 'basePromptCache';
const USER_PROMPT_CACHE_KEY = 'userPromptCache';

// --- Core Recursive Resolver ---

/**
 * The main loop that finds and replaces all `~{{~...~}}~` Portals in a text.
 * It works from the inside out to handle nesting correctly.
 * @param {string} text - The text to resolve.
 * @param {object} procedure - The procedure configuration.
 * @returns {Promise<string>} - The fully resolved text.
 */
async function resolvePortals(text, procedure) {
  const innermostPortalRegex = /~{{~((?:(?!~{{~).)*?)~}}~/;
  let processedText = text;

  while (innermostPortalRegex.test(processedText)) {
    const match = processedText.match(innermostPortalRegex);
    const portalContent = match[1];
    const portalResult = await executePortal(portalContent, procedure);
    processedText = processedText.replace(match[0], portalResult);
  }

  return processedText;
}

/**
 * Executes a single portal's content.
 * @param {string} portalContent - e.g., "'my-prompt'[param1: 'value1']" or "@USER-1:delete"
 * @param {object} procedure - The procedure configuration.
 * @returns {Promise<string>} - The result of the portal execution.
 */
async function executePortal(portalContent, procedure) {
  portalContent = portalContent.trim();

  // Router: Check if it's an Action Portal or a Data Portal
  if (portalContent.startsWith('@')) {
    return await executeActionPortal(portalContent, procedure);
  } else {
    return await executeDataPortal(portalContent, procedure);
  }
}

/**
 * Executes a Data Portal, which resolves a prompt template with parameters.
 * @param {string} portalContent - e.g., "'my-prompt'[param1: 'value1']"
 * @param {object} procedure - The procedure configuration.
 * @returns {Promise<string>} - The resolved text.
 */
async function executeDataPortal(portalContent, procedure) {
    bus.emit('portal:resolve:start', { content: portalContent });
    try {
        const match = portalContent.match(/^'([^']*)'(\[(.*)\])?/);
        if (!match) throw new Error(`Invalid Data Portal syntax: ${portalContent}`);

        const promptId = match[1];
        const paramsString = match[3] || '';
        const params = parseParameters(paramsString);

        const resolvedParams = {};
        for (const key in params) {
            resolvedParams[key] = await resolveValue(params[key], procedure);
        }

        const promptTemplate = await getPromptTemplate(promptId);
        if (!promptTemplate) {
            console.warn(`Aetherflow: Prompt '${promptId}' not found. Replacing with empty string.`);
            return '';
        }

        let output = promptTemplate;
        for (const key in resolvedParams) {
            const regex = new RegExp(`{{${key}}}`, 'g');
            output = output.replace(regex, resolvedParams[key]);
        }

        bus.emit('portal:resolve:success', { content: portalContent, result: output });
        return output;
    } catch (error) {
        bus.emit('portal:resolve:fail', { content: portalContent, error: error.message });
        throw error;
    }
}

/**
 * Executes an Action Portal, which performs a UI manipulation.
 * @param {string} portalContent - e.g., "@USER-1:delete"
 * @param {object} procedure - The procedure configuration.
 * @returns {Promise<string>} - An empty string on success. Throws on failure.
 */
async function executeActionPortal(portalContent, procedure) {
    bus.emit('portal:action:start', { content: portalContent });
    const dom = new ActionPortalDOM(procedure);

    try {
        const [target, action, paramsString] = parseActionSyntax(portalContent);
        const params = parseParameters(paramsString || '');

        const turnElement = dom.findMessageTurn(target);
        if (!turnElement) {
            throw new Error(`Target message "${target}" not found.`);
        }

        switch (action) {
            case 'delete':
                await dom.delete(turnElement);
                break;
            case 'rerun':
                await dom.rerun(turnElement);
                break;
            case 'branch':
                await dom.branch(turnElement);
                break;
            case 'edit':
                const newText = await resolveValue(params['new_text'] || '', procedure);
                if (!newText) throw new Error(":edit action requires a 'new_text' parameter.");
                await dom.edit(turnElement, newText);
                break;
            case 'copy':
                 const format = await resolveValue(params['format'] || "'text'", procedure);
                 await dom.copy(turnElement, format);
                 break;
            default:
                throw new Error(`Unknown action ":${action}".`);
        }

        sessionMemory.setKey('__lastActionStatus', 'SUCCESS');
        bus.emit('portal:action:success', { content: portalContent });
        return '';
    } catch (error) {
        sessionMemory.setKey('__lastActionStatus', 'FAILED');
        bus.emit('portal:action:fail', { content: portalContent, error: error.message });
        throw new Error(`Action Portal failed: ${error.message}`);
    }
}

/**
 * Parses the action portal syntax e.g., "@USER-1:edit[new_text: '...']"
 * @param {string} portalContent - The content of the action portal.
 * @returns {[string, string, string]} - An array containing [target, action, paramsString].
 */
function parseActionSyntax(portalContent) {
    const match = portalContent.match(/(@[A-Z0-9:-]+):(\w+)(\[.*\])?/);
    if (!match) throw new Error(`Invalid Action Portal syntax: ${portalContent}`);
    return [match[1], match[2], match[3]];
}


// --- DOM Manipulation Class for Action Portals ---

class ActionPortalDOM {
    constructor(procedure) {
        this.selectors = procedure.chatHistorySelectors;
        // Add specific action selectors if they exist in the procedure,
        // otherwise use the defaults provided in the briefing.
        this.actionSelectors = procedure.actionSelectors || {
            editButton: 'button[aria-label="Edit"]',
            rerunButton: 'button[aria-label="Rerun this turn"]',
            moreOptionsButton: 'button[aria-label="Open options"]',
            deleteButton: 'button.mat-mdc-menu-item:has-text("Delete")',
            branchButton: 'button.mat-mdc-menu-item:has-text("Branch from here")',
            copyTextButton: 'button.mat-mdc-menu-item:has-text("Copy as text")',
            copyMarkdownButton: 'button.mat-mdc-menu-item:has-text("Copy as markdown")'
        };
    }

    /**
     * Finds the specific message turn container element in the DOM.
     * @param {string} targetLink - The link to the message, e.g., "@USER-1".
     * @returns {HTMLElement|null} - The found element or null.
     */
    findMessageTurn(targetLink) {
        const linkMatch = targetLink.match(/@(?:([^:]+):)?(USER|AI)-(\d+)/);
        if (!linkMatch) return null;

        const [, alias, author, indexStr] = linkMatch;
        const index = parseInt(indexStr, 10);

        let container = document;
        if (alias) {
            // This is a simplified approach. A real implementation would
            // need to handle finding the correct iframe context for conduits.
            // For now, we assume actions only happen on the main page.
            console.warn("Action Portals on Conduits are not yet supported.");
            return null;
        }

        const allTurns = container.querySelectorAll(this.selectors.messageTurnContainer);
        const authorSelector = author === 'USER'
            ? this.selectors.authorIdentification.user
            : this.selectors.authorIdentification.ai.chat; // Use .chat as the primary identifier

        const authorTurns = Array.from(allTurns).filter(turn => turn.querySelector(authorSelector));

        return authorTurns[authorTurns.length - index] || null;
    }

    async #click(element, selector, timeout = 500) {
        const button = element.querySelector(selector);
        if (!button) throw new Error(`Button with selector "${selector}" not found.`);
        button.click();
        await new Promise(r => setTimeout(r, timeout)); // Wait for UI to update
    }

    async #openMoreOptionsAndClick(turnElement, selector) {
        await this.#click(turnElement, this.actionSelectors.moreOptionsButton);
        // The menu is appended to the body, not the turn element
        const menuItem = document.querySelector(selector);
        if (!menuItem) throw new Error(`Menu item with selector "${selector}" not found.`);
        menuItem.click();
    }

    async delete(turnElement) {
        await this.#openMoreOptionsAndClick(turnElement, this.actionSelectors.deleteButton);
    }

    async rerun(turnElement) {
        await this.#click(turnElement, this.actionSelectors.rerunButton);
    }

    async branch(turnElement) {
        await this.#openMoreOptionsAndClick(turnElement, this.actionSelectors.branchButton);
    }

    async copy(turnElement, format = 'text') {
        const selector = format === 'markdown'
            ? this.actionSelectors.copyMarkdownButton
            : this.actionSelectors.copyTextButton;
        await this.#openMoreOptionsAndClick(turnElement, selector);
    }

    async edit(turnElement, newText) {
        await this.#click(turnElement, this.actionSelectors.editButton);
        const textarea = turnElement.querySelector('textarea'); // Assume a textarea appears
        if (!textarea) throw new Error("Could not find textarea after clicking edit.");
        textarea.value = newText;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        // Assuming there's a 'Save' button that appears after editing
        await this.#click(turnElement, 'button[aria-label="Save"]');
    }
}

/**
 * Parses the parameter string `[key: 'value', ...]` into an object.
 * @param {string} paramsString - The string of parameters.
 * @returns {object} - A key-value map of parameters.
 */
function parseParameters(paramsString) {
    const params = {};
    const paramRegex = /(\w+)\s*:\s*('[^']*'|[^,\]]+)/g;
    let match;
    while ((match = paramRegex.exec(paramsString)) !== null) {
        params[match[1].trim()] = match[2].trim();
    }
    return params;
}

/**
 * Resolves a parameter value, which could be a literal, a link, or a nested portal.
 * @param {string} value - The parameter value to resolve.
 * @param {object} procedure - The procedure configuration.
 * @returns {Promise<string>} - The resolved literal value.
 */
async function resolveValue(value, procedure) {
  value = value.trim();

  // It's a nested portal
  if (value.startsWith('~{{~')) {
    return await resolvePortals(value, procedure);
  }

  // It's a link
  if (value.startsWith('@') || value.startsWith('$')) {
    return await resolveLink(value);
  }

  // It's a string literal
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.substring(1, value.length - 1);
  }

  // Assume it's a literal number or unquoted string
  return value;
}

/**
 * Resolves a data link (`@` or `$`) to its content.
 * @param {string} link - The link string (e.g., '@AI-1:thoughts').
 * @returns {Promise<string>} - The resolved content.
 */
async function resolveLink(link) {
    bus.emit('link:resolve:start', { link });
    try {
        let result = '';
        if (link.startsWith('$')) {
            const varName = link.substring(1);
            result = sessionMemory.get()[varName] || '';
        } else if (link.startsWith('@')) {
            let history, target, specifier;
            const linkBody = link.substring(1);

            if (linkBody.includes(':')) {
                const parts = linkBody.split(':');
                const alias = parts[0];
                const conduitHistories = conduits.get();
                history = conduitHistories[alias];
                target = parts[1];
                specifier = parts[2];
            } else {
                history = conversationHistory.get();
                target = linkBody;
            }

            if (history) {
                const match = target.match(/(USER|AI)-(\d+)/);
                if (match) {
                    const authorType = match[1].toLowerCase();
                    const index = parseInt(match[2], 10);
                    const messagesOfAuthor = history.filter(m => m.author === authorType);
                    const targetMessage = messagesOfAuthor[messagesOfAuthor.length - index];

                    if (targetMessage) {
                        if (authorType === 'user') {
                            result = targetMessage.content || '';
                        } else {
                            result = specifier === 'thoughts' ? targetMessage.thoughts : targetMessage.chat;
                        }
                    }
                }
            }
        }
        bus.emit('link:resolve:success', { link, result });
        return result;
    } catch (error) {
        bus.emit('link:resolve:fail', { link, error: error.message });
        return ''; // Fail gracefully for links to prevent halting execution
    }
}

/**
 * Retrieves and parses a single prompt template from browser storage.
 * @param {string} promptId - The ID of the prompt to find (e.g., 'SI-001').
 * @returns {Promise<string|null>} - The prompt's instruction text or null if not found.
 */
async function getPromptTemplate(promptId) {
    const data = await browser.storage.local.get([BASE_PROMPT_CACHE_KEY, USER_PROMPT_CACHE_KEY]);
    const allPromptsRaw = [...(data[BASE_PROMPT_CACHE_KEY] || []), ...(data[USER_PROMPT_CACHE_KEY] || [])];

    // This mimics the parsing logic from content_script.js
    const parsedPrompts = allPromptsRaw.map((rawText, index) => {
        const id = `SI-${String(index + 1).padStart(3, '0')}`;
        const sysMarker = "~~####SYSTEM_INSTRUCTIONS####~~";
        const afterMarker = "~~####PROMPT_AFTER####~~";
        const sysIndex = rawText.indexOf(sysMarker);
        const afterIndex = rawText.indexOf(afterMarker);

        if (sysIndex === -1 || afterIndex === -1) return null;

        const instructions = rawText.substring(sysIndex + sysMarker.length, afterIndex).trim();
        return { id, instructions };
    }).filter(p => p !== null);

    const foundPrompt = parsedPrompts.find(p => p.id === promptId);
    return foundPrompt ? foundPrompt.instructions : null;
}
