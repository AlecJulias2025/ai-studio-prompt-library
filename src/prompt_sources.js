/**
 * prompt_sources.js
 *
 * This file defines the sources for the prompt library. The background script
 * will fetch each of these resources and cache them in local storage.
 *
 * You can add two types of sources:
 * 1. Local Files: Paths relative to the extension's root directory.
 *    Example: 'prompts/my_awesome_prompt.txt'
 * 2. Remote URLs: Full URLs to raw text files (e.g., GitHub Gists, Pastebin raw).
 *    Example: 'https://gist.githubusercontent.com/user/gistid/raw/file.txt'
 */
export const promptSources = [
  'prompts/creative_writer.txt',
  // Example of a second local prompt. Create the file `prompts/code_generator.txt` to use it.
  // 'prompts/code_generator.txt', 
  
  // Example of a remote prompt from a GitHub Gist. Replace with a real URL.
  'https://gist.githubusercontent.com/someuser/123456789abcdef/raw/example_remote_prompt.txt' 
];
