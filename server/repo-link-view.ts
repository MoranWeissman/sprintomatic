/**
 * Pure view logic for orient's repoLink block: turn fetched feature/story
 * data into the packet shape plus ONE pre-formatted plain-English sentence
 * per feature (the capacitySummary pattern — the assistant echoes it verbatim
 * instead of composing its own). No fs, no DB, no ADO here.
 */
import { displayNameFor } from './display-name';
import { classifyBoardState, isDoneState, isRemovedState } from './states';

export type FeatureStage =
  | 'no discovery yet' | 'in discovery' | 'discovery done' | 'in design' | 'design pushed';

export function stageFor(input: {
  hasDiscovery: boolean;
  discoveryFinished: boolean;
  hasDesignDoc: boolean;
  designPushed: boolean;
}): FeatureStage {
  if (input.designPushed) return 'design pushed';
  if (input.hasDesignDoc) return 'in design';
  if (input.discoveryFinished) return 'discovery done';
  if (input.hasDiscovery) return 'in discovery';
  return 'no discovery yet';
}

export interface RepoLinkFeatureInput {
  id: number;
  title: string;
  boardState: string;
  folderPath: string | null;
  /** Null when the feature has no folder, so the stage simply isn't known.
   *  An unknown stage must never be reported as "no discovery yet". */
  stage: FeatureStage | null;
  demoBuilt: boolean;
  childStories: Array<{ id: number; title: string; state: string }>;
}

export interface RepoLinkStoryInput { id: number; title: string; state: string }

export interface OrientRepoLinkFeature {
  id: number;
  displayName: string;
  boardState: string;
  folderPath: string | null;
  stage: FeatureStage | null;
  stories: {
    counts: { done: number; going: number; waiting: number; blocked: number };
    open: Array<{ displayName: string; state: string }>;
  };
  whereWeStand: string;
}

export interface OrientRepoLink {
  features: OrientRepoLinkFeature[];
  stories: Array<{ displayName: string; state: string }>;
  /** Problems worth telling the user about (feature not found, folder missing). */
  notes: string[];
}

const STAGE_PHRASE: Record<FeatureStage, string> = {
  'no discovery yet': 'has no discovery yet',
  'in discovery': 'is in discovery',
  'discovery done': 'is past discovery',
  'in design': 'is in design',
  'design pushed': 'is past design and its stories are on the board',
};

/** The board word for a feature nobody is working on any more, or null while
 *  it is still open. The sentence must lead with this — a feature that is
 *  closed on the board can never read as "is in design". */
function finishedBoardWord(boardState: string): string | null {
  const s = boardState.trim().toLowerCase();
  // Removed first: it is a done state too, but it means gone, not finished.
  if (isRemovedState(s)) return 'was taken off the board';
  if (isDoneState(s)) return `is ${s} on the board`;
  return null;
}

function whereWeStandFor(
  displayName: string,
  stage: FeatureStage | null,
  boardState: string,
  counts: { done: number; going: number; waiting: number; blocked: number },
  total: number,
  demoBuilt: boolean,
): string {
  const finished = finishedBoardWord(boardState);
  // "and its stories are on the board" is only true if the board gave us some.
  // Design can say it pushed stories that were later taken off the board.
  const stagePhrase = stage === null
    ? null
    : stage === 'design pushed' && total === 0
      ? 'is past design'
      : STAGE_PHRASE[stage];
  // No board word and no stage: say nothing we can't back up, just the stories.
  const opening = finished
    ? `${displayName} ${finished}`
    : stagePhrase
      ? `${displayName} ${stagePhrase}`
      : displayName;
  const join = finished || stagePhrase ? '; ' : ': ';
  if (total === 0) {
    return finished ? `${opening}.` : `${opening}${join}no stories on the board yet.`;
  }
  // "1 of 1 story is done" — a lone story must not read as "1 of 1 stories are".
  const parts: string[] = total === 1
    ? [`${counts.done} of 1 story is done`]
    : [`${counts.done} of ${total} stories are done`];
  if (counts.going > 0) parts.push(`${counts.going} ${counts.going === 1 ? 'is' : 'are'} being worked on`);
  if (counts.waiting > 0) parts.push(`${counts.waiting} ${counts.waiting === 1 ? 'is' : 'are'} waiting`);
  if (counts.blocked > 0) parts.push(`${counts.blocked} ${counts.blocked === 1 ? 'is' : 'are'} blocked`);
  if (demoBuilt) parts.push('the demo is built');
  const last = parts.pop()!;
  const body = parts.length > 0 ? `${parts.join(', ')}, and ${last}` : last;
  return `${opening}${join}${body}.`;
}

export function repoLinkBlock(
  features: RepoLinkFeatureInput[],
  stories: RepoLinkStoryInput[],
  notes: string[],
): OrientRepoLink {
  return {
    features: features.map(f => {
      const counted = f.childStories.filter(s => !isRemovedState(s.state));
      const counts = { done: 0, going: 0, waiting: 0, blocked: 0 };
      const open: Array<{ displayName: string; state: string }> = [];
      for (const s of counted) {
        const kind = classifyBoardState(s.state);
        if (kind === 'done') { counts.done += 1; continue; }
        if (kind === 'active') counts.going += 1;
        else if (kind === 'blocked') counts.blocked += 1;
        // A state name we don't know still has to land somewhere or the
        // counts stop adding up to the number of stories we just said.
        else counts.waiting += 1;
        open.push({ displayName: displayNameFor(s.id, s.title), state: s.state });
      }
      const displayName = displayNameFor(f.id, f.title);
      return {
        id: f.id,
        displayName,
        boardState: f.boardState,
        folderPath: f.folderPath,
        stage: f.stage,
        stories: { counts, open },
        whereWeStand: whereWeStandFor(
          displayName, f.stage, f.boardState, counts, counted.length, f.demoBuilt,
        ),
      };
    }),
    stories: stories.map(s => ({ displayName: displayNameFor(s.id, s.title), state: s.state })),
    notes,
  };
}
