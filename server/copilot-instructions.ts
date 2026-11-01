/**
 * GitHub Copilot CLI support: the instructions file and the MCP config entry.
 *
 * Claude Code puts an MCP server's `instructions` text into every chat. The
 * Copilot CLI does not — not for a server it doesn't already know, unless the
 * chat was started with a special flag. So in Copilot the AI would never see
 * the rules for how to use the tools.
 *
 * What Copilot does read in every chat is every
 * `~/.copilot/instructions/**\/*.instructions.md` file (or the same folder
 * under COPILOT_HOME when that is set). So setup writes the same rules into
 * one such file, and the MCP server rewrites it at startup whenever the rules
 * in the code have changed. The server never creates the file on its own: if
 * the user never ran setup for Copilot, or deleted the file, it stays gone.
 *
 * Setup also adds the `sprintomatic` entry to `~/.copilot/mcp-config.json`,
 * only when it is not there yet, and leaves every other server alone.
 */
import { existsSync, readFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomicSync, type AtomicWriter } from './atomic-write';

type Env = Record<string, string | undefined>;

/** The Copilot CLI's own folder: COPILOT_HOME when set, else ~/.copilot. */
export function copilotHomeDir(home: string = homedir(), env: Env = process.env): string {
  const fromEnv = env.COPILOT_HOME?.trim();
  return fromEnv ? fromEnv : join(home, '.copilot');
}

/** Where the sprintomatic rules file for Copilot lives. */
export function copilotInstructionsPath(home: string = homedir(), env: Env = process.env): string {
  return join(copilotHomeDir(home, env), 'instructions', 'sprintomatic.instructions.md');
}

/** Where the Copilot CLI keeps its list of MCP servers. */
export function copilotMcpConfigPath(home: string = homedir(), env: Env = process.env): string {
  return join(copilotHomeDir(home, env), 'mcp-config.json');
}

/** The whole file: a short header saying where it came from, then the rules as they are. */
export function renderCopilotInstructions(serverInstructions: string): string {
  return [
    '---',
    'applyTo: "**"',
    '---',
    '',
    '<!--',
    'This file is written by sprintomatic. Do not edit it by hand: the',
    'sprintomatic MCP server rewrites it from its own code every time it starts.',
    'It is here because GitHub Copilot CLI does not show an MCP server\'s',
    'instructions to the AI on its own. To remove it, delete this file and',
    'the "sprintomatic" entry in mcp-config.json next to this folder.',
    '-->',
    '',
    serverInstructions.trim(),
    '',
  ].join('\n');
}

/** Swappable file steps, so tests can point at a temp folder or make a write fail. */
export interface CopilotFileDeps {
  /** Full path of the instructions file. Defaults to copilotInstructionsPath(). */
  path?: string;
  writer?: AtomicWriter;
}

export type CopilotSyncResult = 'unchanged' | 'updated' | 'not-installed' | 'failed';

/**
 * Bring the instructions file in step with the rules in the code. Only touches
 * a file that is already there. Never throws: the MCP server calls this at
 * startup, and a failure here must not stop the server.
 */
export function syncCopilotInstructions(serverInstructions: string, deps: CopilotFileDeps = {}): CopilotSyncResult {
  try {
    const path = deps.path ?? copilotInstructionsPath();
    if (!existsSync(path)) return 'not-installed';
    const want = renderCopilotInstructions(serverInstructions);
    if (readFileSync(path, 'utf8') === want) return 'unchanged';
    writeFileAtomicSync(path, want, deps.writer);
    return 'updated';
  } catch {
    return 'failed';
  }
}

/** Write the instructions file, making its folders if needed. Used by setup. Throws on failure. */
export function installCopilotInstructions(serverInstructions: string, deps: CopilotFileDeps = {}): string {
  const path = deps.path ?? copilotInstructionsPath();
  writeFileAtomicSync(path, renderCopilotInstructions(serverInstructions), deps.writer);
  return path;
}

export interface CopilotServerEntry {
  type: 'local';
  command: string;
  args: string[];
  tools: string[];
  env?: Record<string, string>;
}

/** The mcp-config.json entry: `npx -y sprintomatic` for an npm install, `npm run mcp` for a clone. */
export function copilotServerEntry(installed: boolean, repo: string): CopilotServerEntry {
  return installed
    ? { type: 'local', command: 'npx', args: ['-y', 'sprintomatic'], tools: ['*'] }
    : { type: 'local', command: 'npm', args: ['--prefix', repo, 'run', 'mcp', '--silent'], tools: ['*'] };
}

export type McpConfigResult = 'added' | 'already-there' | 'unreadable';

/**
 * Add the sprintomatic entry to mcp-config.json when it is not there yet.
 * Every other server in the file stays exactly as it was. Before changing a
 * file that was already there, a copy of it is kept as mcp-config.json.bak.
 * A file that isn't valid JSON is left alone and reported as 'unreadable'.
 */
export function addCopilotMcpServer(
  entry: CopilotServerEntry,
  deps: { path?: string; name?: string; writer?: AtomicWriter } = {},
): McpConfigResult {
  const path = deps.path ?? copilotMcpConfigPath();
  const name = deps.name ?? 'sprintomatic';
  let config: Record<string, unknown> = {};
  const existed = existsSync(path);
  if (existed) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unreadable';
      config = parsed as Record<string, unknown>;
    } catch {
      return 'unreadable';
    }
  }
  const servers = config.mcpServers;
  if (servers != null && (typeof servers !== 'object' || Array.isArray(servers))) return 'unreadable';
  const list = (servers ?? {}) as Record<string, unknown>;
  if (name in list) return 'already-there';
  if (existed) copyFileSync(path, `${path}.bak`);
  const next = { ...config, mcpServers: { ...list, [name]: entry } };
  writeFileAtomicSync(path, JSON.stringify(next, null, 2) + '\n', deps.writer);
  return 'added';
}

/** True when the Copilot CLI looks installed: COPILOT_HOME is set, or ~/.copilot exists. */
export function copilotPresent(home: string = homedir(), env: Env = process.env): boolean {
  return Boolean(env.COPILOT_HOME?.trim()) || existsSync(join(home, '.copilot'));
}

export interface SetupCopilotResult {
  mcpConfig: McpConfigResult;
  mcpConfigPath: string;
  instructionsPath: string;
}

/**
 * The Copilot part of setup: add the MCP server entry (when missing) and write
 * the instructions file. Throws if a file can't be written; setup reports it.
 */
export function setupCopilot(
  serverInstructions: string,
  opts: { installed: boolean; repo: string; home?: string; env?: Env },
): SetupCopilotResult {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const mcpConfigPath = copilotMcpConfigPath(home, env);
  const mcpConfig = addCopilotMcpServer(copilotServerEntry(opts.installed, opts.repo), { path: mcpConfigPath });
  const instructionsPath = installCopilotInstructions(serverInstructions, { path: copilotInstructionsPath(home, env) });
  return { mcpConfig, mcpConfigPath, instructionsPath };
}
