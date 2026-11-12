#!/usr/bin/env node
/**
 * The one command an installed copy has.
 *
 *   sprintomatic            the MCP server (what Claude Code runs)
 *   sprintomatic setup      first-time setup, one question at a time
 *   sprintomatic dashboard  the dashboard on http://localhost:7777
 *   sprintomatic demo       the dashboard on a made-up board, http://localhost:7778
 *   sprintomatic guard ...  the session guard hook, and `guard install` to add it
 *   sprintomatic help       what each command does
 *
 * No word means the MCP server, so `npx -y sprintomatic` is the whole line
 * an MCP client needs. Each part loads only when asked for: the server and
 * the dashboard start themselves the moment they are imported.
 */
import { createRequire } from 'node:module';

const HELP = `sprintomatic: keeps your Azure DevOps sprint up to date while you work with an AI chat.

  npx sprintomatic setup       set it up, one question at a time
  npx sprintomatic dashboard   open the dashboard on http://localhost:7777
  npx sprintomatic demo        try it on a made-up board, http://localhost:7778
  npx sprintomatic guard install
                               add the hook that asks the chat to open a session before edits
  npx sprintomatic             the MCP server. Your AI chat starts this, not you.
  npx sprintomatic --version   the installed version

More: https://www.npmjs.com/package/sprintomatic
`;

function version(): string {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

const command = process.argv[2] ?? 'mcp';

switch (command) {
  case 'mcp':
    // Run by hand in a terminal, the server just sits and waits for a chat to
    // talk to it, which looks broken. Say what it is, on stderr so the MCP
    // line on stdout stays clean.
    if (process.argv[2] === undefined && process.stdin.isTTY) {
      process.stderr.write(
        'This is the sprintomatic MCP server. Your AI chat starts it, so there is nothing to type here.\n' +
          'To try it: npx sprintomatic demo. To set it up: npx sprintomatic setup. Press Ctrl+C to stop.\n',
      );
    }
    await import('../mcp/server');
    break;
  case 'setup':
    await import('./setup');
    break;
  case 'dashboard':
    await import('../server/serve');
    break;
  case 'guard':
    await import('./guard');
    break;
  case 'demo':
    // Set before the import, so every part reads demo mode from the start.
    process.env.SPRINTOMATIC_DEMO = '1';
    await import('../server/serve');
    break;
  case 'help':
  case '--help':
  case '-h':
    process.stdout.write(HELP);
    break;
  case 'version':
  case '--version':
  case '-v':
    process.stdout.write(`${version()}\n`);
    break;
  default:
    process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
    process.exitCode = 1;
}

export {};
