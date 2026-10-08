// server/discovery-list.ts
/**
 * Pure logic for the D&D page's feature list: turn workspace folders into a
 * status-grouped list of the features the user has touched. No fs/ADO here — the
 * route glue injects readdir and supplies discovery/board status. Never throws.
 */
import { join } from 'node:path';

export type DndStatus = 'in-progress' | 'not-started' | 'closed';

export interface TouchedFeature { id: number; folderPath: string }

export interface FeatureListEntry {
  id: number;
  displayName: string;       // **<title>** (#<id>) — names before numbers
  folderPath: string;
  dndStatus: DndStatus;
  boardState: string | null; // ADO state of the discovery story, null if unresolved
  dayLabel: string | null;   // e.g. "day 2 of 2", only for the active feature
}

export interface FeatureSection { status: DndStatus; features: FeatureListEntry[] }

const SECTION_ORDER: DndStatus[] = ['in-progress', 'not-started', 'closed'];

/** Parse a `<id>-<slug>` or bare `<id>` feature-folder name. Non-feature → null. */
export function parseFeatureFolder(name: string): { id: number } | null {
  const m = name.match(/^(\d+)(?:-.*)?$/);
  if (!m) return null;
  return { id: Number(m[1]) };
}

/** Scan each workspace's immediate children for feature folders. readdir is
 *  injected (testable, no fs). A path whose readdir throws is skipped. Deduped
 *  by id, first occurrence wins. */
export function listTouchedFeatureFolders(
  workspacePaths: string[],
  readdir: (dir: string) => string[],
): TouchedFeature[] {
  const seen = new Set<number>();
  const out: TouchedFeature[] = [];
  for (const ws of workspacePaths) {
    let names: string[];
    try { names = readdir(ws); } catch { continue; }
    for (const name of names) {
      const parsed = parseFeatureFolder(name);
      if (!parsed || seen.has(parsed.id)) continue;
      seen.add(parsed.id);
      out.push({ id: parsed.id, folderPath: join(ws, name) });
    }
  }
  return out;
}

/** The BOARD decides "done", not the file. A discovery is only over when the user
 *  closes its story in Azure DevOps — a filled-in file is still "in progress"
 *  until then. So: story closed → closed; else a discovery exists → in-progress;
 *  else → not-started. (`finished` from the file no longer changes the status;
 *  it stays a separate "ready to close" hint the row can show.) */
export function deriveDndStatus(args: {
  hasDiscovery: boolean; boardClosed: boolean;
}): DndStatus {
  if (args.boardClosed) return 'closed';
  if (args.hasDiscovery) return 'in-progress';
  return 'not-started';
}

/** Group entries into fixed-order sections, omitting empty ones. */
export function groupByDndStatus(entries: FeatureListEntry[]): FeatureSection[] {
  return SECTION_ORDER
    .map(status => ({ status, features: entries.filter(e => e.dndStatus === status) }))
    .filter(s => s.features.length > 0);
}
