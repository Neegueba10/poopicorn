// Shared bits for the test suites: server address, repo paths, and a
// place to drop debug screenshots (tests/.artifacts/, gitignored).
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PORT = +(process.env.TOOLS_PORT || 8788);
export const BASE = `http://localhost:${PORT}`;

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function artifact(name) {
  const dir = fileURLToPath(new URL('./.artifacts/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  return dir + name;
}
