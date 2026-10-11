/**
 * Where sprintomatic keeps its files, and whether this is the demo.
 *
 * The demo (SPRINTOMATIC_DEMO=1, or `sprintomatic demo`) runs on a made-up
 * board (server/demo-board.ts) and keeps everything in its own folder, so
 * trying it out never touches a real setup. Every path to the data folder
 * goes through here, so that promise has one place to hold.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** True when this process runs the demo. */
export function isDemo(): boolean {
  const v = process.env.SPRINTOMATIC_DEMO;
  return v != null && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

/** The data folder: ~/.sprintomatic, or ~/.sprintomatic-demo in the demo. */
export function dataDir(): string {
  return join(homedir(), isDemo() ? '.sprintomatic-demo' : '.sprintomatic');
}
