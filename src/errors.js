/**
 * errors.js
 *
 * Defines custom error types for the application.
 */

/**
 * Custom error class for Aetherflow data linking failures.
 * This helps distinguish between parsing errors and other unexpected errors.
 */
export class DataLinkError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = 'DataLinkError';
    this.context = context; // e.g., { link: '@AI-1', type: 'link' }
  }
}
