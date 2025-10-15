/**
 * src/event_bus.js
 *
 * This module creates and exports a single, centralized event bus instance.
 * Using a dedicated module ensures that all parts of the extension that import
 * this file are interacting with the exact same event emitter.
 */
import mitt from 'mitt';
export const bus = mitt();
