import { Console } from 'node:console';

// Keep this bootstrap separate from all plugin and SDK modules in released builds.
// Rust discards stderr; stdout belongs only to the worker's JSON frame writer.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
await import('./worker.js');
