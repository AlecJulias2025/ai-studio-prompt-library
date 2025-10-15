import { map, atom } from 'nanostores';

/**
 * aetherflow_state.js
 *
 * Centralized state management for the Aetherflow engine using nanostores.
 * This ensures a reactive and efficient data layer, especially for handling
 * the "virtually woven" structure of Conduits.
 */

/**
 * Session Memory (`$varName`)
 * Stores key-value pairs for the current user session. Portals can read
 * from and write to this store. It's a `map` for efficient key-based access.
 */
export const sessionMemory = map({});

/**
 * Current Conversation History (`@USER-#`, `@AI-#`)
 * Holds the scraped message history of the active conversation.
 * An atom is suitable here as we'll likely replace the entire
 * history array in one go after scraping it.
 */
export const conversationHistory = atom([]);

/**
 * Conduits (`#> mount`, `@Alias:USER-#`)
 * A map-based store to hold the histories of other mounted conversations.
 * The key is the 'Alias' defined in the `#> mount` directive, and the
 * value is the array of scraped messages for that conversation.
 */
export const conduits = map({});
