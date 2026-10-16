// The full library: the browser-safe subset plus the Node helpers the CLI uses.
export * from './browser.js';
export { dirSource } from './node.js';
export { formatReport, main, parseArgs } from './cli.js';
