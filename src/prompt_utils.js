/**
 * prompt_utils.js
 *
 * This module provides utility functions for handling and parsing prompt files.
 * It centralizes the logic to avoid duplication across different parts of the extension.
 */

/**
 * Parses the raw text of a prompt file into a structured object.
 * This is the single source of truth for prompt parsing.
 *
 * @param {string} rawText - The raw text content of a prompt file.
 * @param {number} index - The index of the prompt in the source list, used to generate a stable ID.
 * @returns {{id: string, markdown: string, instructions: string}|null} - A structured object or null if parsing fails.
 */
export function parsePromptText(rawText, index) {
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
