#!/usr/bin/env node
/**
 * The one command an installed copy has.
 *
 *   sprintomatic            the MCP server (what Claude Code runs)
 *   sprintomatic setup      first-time setup, one question at a time
 *   sprintomatic dashboard  the dashboard on http://localhost:7777
 *   sprintomatic demo       the dashboard on a made-up board, http://localhost:7778
 *
 * No word means the MCP server, so `npx -y sprintomatic` is the whole line
 * an MCP client needs. Each part loads only when asked for: the server and
 * the dashboard start themselves the moment they are imported.
 */
const command = process.argv[2] ?? 'mcp';

switch (command) {
  case 'mcp':
    await import('../mcp/server');
    break;
  case 'setup':
    await import('./setup');
    break;
  case 'dashboard':
    await import('../server/serve');
    break;
  case 'demo':
    // Set before the import, so every part reads demo mode from the start.
    process.env.SPRINTOMATIC_DEMO = '1';
    await import('../server/serve');
    break;
  default:
    console.error(`Unknown command: ${command}. Use one of: setup, dashboard, demo (or nothing for the MCP server).`);
    process.exitCode = 1;
}

export {};
