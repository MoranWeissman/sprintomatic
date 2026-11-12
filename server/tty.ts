/**
 * The terminal a chat runs in, like "ttys004".
 *
 * Every Claude Code chat lives in its own terminal tab, and both its hooks and
 * its MCP server are child processes of it. So the nearest parent that has a
 * terminal names the chat. That links a session to the chat that opened it
 * with no help from the model. Null when there is none (a GUI client) or ps
 * fails.
 */
import { execFileSync } from 'node:child_process';

export function findChatTty(startPid = process.pid, maxHops = 8): string | null {
  try {
    let pid = startPid;
    for (let i = 0; i < maxHops && pid > 1; i++) {
      const [ppid, tty] = execFileSync('ps', ['-o', 'ppid=,tty=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 1000,
      })
        .trim()
        .split(/\s+/);
      if (tty && !tty.startsWith('?')) return tty;
      pid = Number(ppid);
    }
    return null;
  } catch {
    return null;
  }
}

let cached: string | null | undefined;
/** This process's chat terminal, looked up once. */
export function ownChatTty(): string | null {
  if (cached === undefined) cached = findChatTty();
  return cached;
}
