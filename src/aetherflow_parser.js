/**
 * aetherflow_parser.js
 *
 * The core engine for parsing and executing Aetherflow scripting syntax.
 * This module is responsible for recursively resolving all Aetherflow commands
 * into a final, clean string to be sent to the AI.
 */

import { sessionMemory, conversationHistory, conduits } from './aetherflow_state.js';
// Note: We will need to import browser storage access logic later.

let _conversationScraped = false; // Memoization flag for the current conversation scraper

// --- Main Export ---

/**
 * Parses a raw text string containing Aetherflow syntax and resolves it.
 * @param {string} rawText - The user's input text.
 * @param {object} procedure - The procedure configuration with DOM selectors.
 * @returns {Promise<string>} - A promise that resolves to the final, clean text.
 */
export async function parse(rawText, procedure) {
  console.log('Aetherflow: Parsing started.');
  _conversationScraped = false; // Reset memoization flag for each new parse

  // Phase 1: Mount Conduits (Not yet implemented)
  const textAfterMounts = await resolveConduits(rawText, procedure);

  // Phase 2: Scrape current conversation history
  await scrapeCurrentConversation(procedure);

  // Phase 3: Recursively resolve Portals
  const finalText = await resolvePortals(textAfterMounts, procedure);

  console.log('Aetherflow: Parsing complete.');
  return finalText;
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

    // Return the text with the mount directives stripped out.
    return text.replace(mountRegex, '').trim();
}

/**
 * Creates a hidden iframe to scrape a conversation and mounts it into the conduits store.
 * This process is transactional.
 * @param {string} alias - The alias for the mounted conversation.
 * @param {string} chatUID - The UID of the chat to load.
 * @param {object} procedure - The procedure configuration.
 */
async function mountConduit(alias, chatUID, procedure) {
    console.log(`Aetherflow: Mounting Conduit '${alias}' from chat '${chatUID}'...`);
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';

    try {
        await new Promise((resolve, reject) => {
            iframe.onload = () => {
                try {
                    const selectors = procedure.chatHistorySelectors;
                    const history = scrapeConversationFromDoc(iframe.contentDocument, selectors);

                    // Transactional update: only set state on full success
                    conduits.setKey(alias, history);
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
        console.error(`Aetherflow: Failed to mount Conduit '${alias}'.`, error);
        // Do not update state, ensuring transactional integrity.
    } finally {
        // Cleanup: always remove the iframe.
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
 * @param {string} portalContent - e.g., "'my-prompt'[param1: 'value1']"
 * @param {object} procedure - The procedure configuration.
 * @returns {Promise<string>} - The result of the portal execution.
 */
async function executePortal(portalContent, procedure) {
  const match = portalContent.trim().match(/^'([^']*)'(\[(.*)\])?/);
  if (!match) throw new Error(`Invalid Portal syntax: ${portalContent}`);

  const promptId = match[1];
  const paramsString = match[3] || '';
  const params = parseParameters(paramsString);

  // Resolve all parameter values asynchronously
  const resolvedParams = {};
  for (const key in params) {
    resolvedParams[key] = await resolveValue(params[key], procedure);
  }

  const promptTemplate = await getPromptTemplate(promptId);
  if (!promptTemplate) {
      console.warn(`Aetherflow: Prompt with ID '${promptId}' not found. Replacing with empty string.`);
      return '';
  }

  // Inject resolved params into the template
  let output = promptTemplate;
  for (const key in resolvedParams) {
    const regex = new RegExp(`{{${key}}}`, 'g');
    output = output.replace(regex, resolvedParams[key]);
  }

  return output;
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
    // Session Memory Variable: $varName
    if (link.startsWith('$')) {
        const varName = link.substring(1);
        return sessionMemory.get()[varName] || '';
    }

    // Conversation History Link: @...
    if (link.startsWith('@')) {
        let history, target, specifier;
        const linkBody = link.substring(1);

        // Check for Cross-Conduit link: @Alias:USER-#...
        if (linkBody.includes(':')) {
            const parts = linkBody.split(':');
            const alias = parts[0];
            const conduitHistories = conduits.get();
            history = conduitHistories[alias];
            target = parts[1];
            specifier = parts[2]; // Can be undefined
        } else { // It's a local conversation link
            history = conversationHistory.get();
            target = linkBody;
            specifier = undefined;
        }

        if (!history) return ''; // History not found

        const match = target.match(/(USER|AI)-(\d+)/);
        if (!match) return '';

        const authorType = match[1].toLowerCase();
        const index = parseInt(match[2], 10);

        const messagesOfAuthor = history.filter(m => m.author === authorType);
        const targetMessage = messagesOfAuthor[messagesOfAuthor.length - index];

        if (!targetMessage) return '';

        if (authorType === 'user') {
            return targetMessage.content || '';
        } else { // authorType is 'ai'
            return specifier === 'thoughts' ? targetMessage.thoughts : targetMessage.chat;
        }
    }

    return ''; // Should not be reached
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
