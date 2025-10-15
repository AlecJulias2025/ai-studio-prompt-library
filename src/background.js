/**
 * background.js
 * Service Worker for the extension.
 *
 * Responsibilities:
 * 1. On install/startup, fetches all prompts from the sources defined in `prompt_sources.js`.
 * 2. Caches the fetched prompt content into `browser.storage.local`.
 * 3. Listens for messages from the options page to trigger a manual refresh of the prompts.
 * 4. Opens the options page when the action button is clicked.
 */
const PROMPT_SOURCES_KEY = 'promptSources';
const BASE_PROMPT_CACHE_KEY = 'basePromptCache';
const USER_PROMPT_CACHE_KEY = 'userPromptCache';

/**
 * Fetches content from a single source, handling both local and remote URLs.
 * @param {string} source - The URL or local path of the prompt file.
 * @returns {Promise<string>} - A promise that resolves with the text content.
 */
async function fetchPrompt(source) {
  const isRemote = source.startsWith('http');
  const fetchUrl = isRemote ? source : browser.runtime.getURL(source);
  
  try {
    const response = await fetch(fetchUrl);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status} for ${source}`);
    }
    return await response.text();
  } catch (error) {
    console.error(`Failed to fetch prompt from ${source}:`, error);
    // Propagate the error to be caught by Promise.allSettled
    return Promise.reject(error);
  }
}

/**
 * Fetches all prompts from the sources list, processes them, and saves to storage.
 */
async function fetchAndCachePrompts() {
  console.log('Starting prompt fetch and cache process...');
  
  const data = await browser.storage.local.get(PROMPT_SOURCES_KEY);
  const promptSources = data[PROMPT_SOURCES_KEY] || [];

  const promises = promptSources.map(source => fetchPrompt(source));
  const results = await Promise.allSettled(promises);
  
  const successfulFetches = results
    .filter(result => result.status === 'fulfilled' && result.value)
    .map(result => result.value);
  
  await browser.storage.local.set({ [BASE_PROMPT_CACHE_KEY]: successfulFetches });
  console.log(`Successfully cached ${successfulFetches.length} of ${promptSources.length} prompts.`);

  // TODO: Add badge text to the extension icon to show the number of loaded prompts.
  // await browser.action.setBadgeText({ text: String(successfulFetches.length) });
  // await browser.action.setBadgeBackgroundColor({ color: '#4CAF50' });
  updateBadge();
}

async function updateBadge() {
    const data = await browser.storage.local.get([BASE_PROMPT_CACHE_KEY, USER_PROMPT_CACHE_KEY]);
    const basePrompts = data[BASE_PROMPT_CACHE_KEY] || [];
    const userPrompts = data[USER_PROMPT_CACHE_KEY] || [];
    const totalPrompts = basePrompts.length + userPrompts.length;

    await browser.action.setBadgeText({ text: String(totalPrompts) });
    await browser.action.setBadgeBackgroundColor({ color: '#4CAF50' });
}

/**
 * Main listener for extension installation or browser startup.
 */
browser.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === 'install') {
        // On first install, populate storage with the default sources.
        const defaultSources = [
            'prompts/creative_writer.txt',
            'https://github.com/AlecJulias2025/ai_studio_prompt_library_extension/blob/76a128633713ad69a0c045304d30f2d89e6dcdfd/gbg/test.md'
        ];
        await browser.storage.local.set({ [PROMPT_SOURCES_KEY]: defaultSources });
    }
    // Always fetch and cache on install or update.
    fetchAndCachePrompts();
});
// Note: For Manifest V3, `onInstalled` is usually sufficient. 
// onStartup runs every time the browser starts if the extension is enabled.
browser.runtime.onStartup.addListener(fetchAndCachePrompts);

/**
 * Listener for messages from other parts of the extension.
 */
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'refreshPrompts') {
        fetchAndCachePrompts().then(() => sendResponse({ status: 'ok' }));
        return true; // Asynchronous response
    }

    if (message.action === 'importPrompt') {
        handleImportPrompt(message)
            .then(() => sendResponse({ status: 'ok' }))
            .catch(error => sendResponse({ status: 'error', error: error.message }));
        return true; // Asynchronous response
    }
});

async function handleImportPrompt(message) {
    let { type, content } = message;

    if (type === 'url') {
        try {
            const response = await fetch(content); // content is the URL string
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            content = await response.text();
        } catch (error) {
            console.error(`Failed to fetch prompt from URL ${content}:`, error);
            throw error;
        }
    }

    // Splice the content to get the main prompt
    const systemInstructionsMarker = '~~####SYSTEM_INSTRUCTIONS####~~';
    const promptAfterMarker = '~~####PROMPT_AFTER####~~';

    let promptText = content; // Default to full content
    const siIndex = content.indexOf(systemInstructionsMarker);
    const paIndex = content.indexOf(promptAfterMarker);

    if (siIndex !== -1 && paIndex !== -1) {
        promptText = content.substring(siIndex + systemInstructionsMarker.length, paIndex).trim();
    } else {
        // If markers are not found, we can decide to reject or use the whole file.
        // For now, let's just use the whole file but log a warning.
        console.warn("Markers not found in imported prompt. Using the entire content.");
    }

    // Add the parsed content to the existing cache
    const data = await browser.storage.local.get(USER_PROMPT_CACHE_KEY);
    const existingCache = data[USER_PROMPT_CACHE_KEY] || [];
    const updatedCache = [...existingCache, promptText];

    await browser.storage.local.set({ [USER_PROMPT_CACHE_KEY]: updatedCache });

    // Optional: Refresh any open library views. This is more complex.
    // For now, the user will see the new prompt the next time the library is opened/refreshed.
    console.log('New prompt added to cache.');
    updateBadge();
}


/**
 * Listener for extension icon click
 */
browser.action.onClicked.addListener(() => {
    browser.runtime.openOptionsPage();
});
