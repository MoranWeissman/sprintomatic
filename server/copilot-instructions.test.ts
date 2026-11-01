import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  copilotInstructionsPath,
  renderCopilotInstructions,
  syncCopilotInstructions,
  installCopilotInstructions,
  addCopilotMcpServer,
  copilotServerEntry,
  setupCopilot,
} from './copilot-instructions';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'copilot-instr-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('copilotInstructionsPath', () => {
  it('uses ~/.copilot when COPILOT_HOME is not set', () => {
    expect(copilotInstructionsPath(root, {})).toBe(join(root, '.copilot', 'instructions', 'sprintomatic.instructions.md'));
  });
  it('uses COPILOT_HOME when set', () => {
    const ch = join(root, 'elsewhere');
    expect(copilotInstructionsPath(root, { COPILOT_HOME: ch })).toBe(join(ch, 'instructions', 'sprintomatic.instructions.md'));
  });
});

describe('renderCopilotInstructions', () => {
  it('starts with applyTo frontmatter and keeps the rules as they are', () => {
    const out = renderCopilotInstructions('RULE ONE\nRULE TWO');
    expect(out.startsWith('---\napplyTo: "**"\n---\n')).toBe(true);
    expect(out).toContain('Do not edit it by hand');
    expect(out.endsWith('RULE ONE\nRULE TWO\n')).toBe(true);
  });
});

describe('syncCopilotInstructions', () => {
  const path = () => join(root, 'instructions', 'sprintomatic.instructions.md');

  it('does not create the file when it is not there', () => {
    expect(syncCopilotInstructions('rules', { path: path() })).toBe('not-installed');
    expect(existsSync(path())).toBe(false);
  });

  it('rewrites a file that is out of date, then leaves it alone', () => {
    installCopilotInstructions('old rules', { path: path() });
    expect(syncCopilotInstructions('new rules', { path: path() })).toBe('updated');
    expect(readFileSync(path(), 'utf8')).toBe(renderCopilotInstructions('new rules'));
    expect(syncCopilotInstructions('new rules', { path: path() })).toBe('unchanged');
  });

  it('returns failed instead of throwing, and keeps the old file', () => {
    installCopilotInstructions('old rules', { path: path() });
    const writer = { writeFile: () => { throw new Error('disk full'); }, rename: () => {} };
    expect(syncCopilotInstructions('new rules', { path: path(), writer })).toBe('failed');
    expect(readFileSync(path(), 'utf8')).toBe(renderCopilotInstructions('old rules'));
  });
});

describe('addCopilotMcpServer', () => {
  const cfg = () => join(root, 'mcp-config.json');
  const entry = copilotServerEntry(true, '');

  it('creates the file when missing', () => {
    expect(addCopilotMcpServer(entry, { path: cfg() })).toBe('added');
    expect(JSON.parse(readFileSync(cfg(), 'utf8'))).toEqual({ mcpServers: { sprintomatic: entry } });
    expect(existsSync(`${cfg()}.bak`)).toBe(false);
  });

  it('keeps other servers and settings, and saves a .bak of the old file', () => {
    const before = JSON.stringify({ other: 1, mcpServers: { foo: { command: 'foo' } } });
    writeFileSync(cfg(), before);
    expect(addCopilotMcpServer(entry, { path: cfg() })).toBe('added');
    expect(JSON.parse(readFileSync(cfg(), 'utf8'))).toEqual({
      other: 1,
      mcpServers: { foo: { command: 'foo' }, sprintomatic: entry },
    });
    expect(readFileSync(`${cfg()}.bak`, 'utf8')).toBe(before);
  });

  it('leaves an existing sprintomatic entry alone', () => {
    const before = JSON.stringify({ mcpServers: { sprintomatic: { command: 'mine' } } });
    writeFileSync(cfg(), before);
    expect(addCopilotMcpServer(entry, { path: cfg() })).toBe('already-there');
    expect(readFileSync(cfg(), 'utf8')).toBe(before);
  });

  it('does not touch a file that is not valid JSON', () => {
    writeFileSync(cfg(), '{ broken');
    expect(addCopilotMcpServer(entry, { path: cfg() })).toBe('unreadable');
    expect(readFileSync(cfg(), 'utf8')).toBe('{ broken');
  });
});

describe('copilotServerEntry', () => {
  it('points a clone at npm run mcp', () => {
    expect(copilotServerEntry(false, join(root, 'repo')).args).toEqual(['--prefix', join(root, 'repo'), 'run', 'mcp', '--silent']);
  });
});

describe('setupCopilot', () => {
  it('writes both files under COPILOT_HOME', () => {
    const ch = join(root, 'ch');
    mkdirSync(ch);
    const r = setupCopilot('rules', { installed: true, repo: '', home: root, env: { COPILOT_HOME: ch } });
    expect(r.mcpConfig).toBe('added');
    expect(r.mcpConfigPath).toBe(join(ch, 'mcp-config.json'));
    expect(readFileSync(r.instructionsPath, 'utf8')).toBe(renderCopilotInstructions('rules'));
  });
});
