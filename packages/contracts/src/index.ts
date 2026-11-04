/**
 * `@narrative-studio/contracts`
 *
 * Versioned domain contracts, JSON Schemas and pure helpers for Narrative
 * Studio. This package has no I/O of its own beyond `node:crypto` hashing, so
 * Story Core, projections, jobs and the CLI all agree on the same shapes.
 */

export * from './types.js';
export * from './errors.js';
export * from './ids.js';
export * from './text.js';
export * from './schemas.js';
export * from './validate.js';
