import { describe, it, expect } from 'vitest';
import {
  selectShareFiles, pickFeatureBranch, pickTargetFolder,
  commitMessage, compareUrl, isProtectedBranch,
} from './feature-share';

describe('selectShareFiles', () => {
  it('keeps the readable docs, diagrams, demos and story docs', () => {
    const input = [
      'discovery/discovery.md',
      'discovery/meetings/2026-07-27.md',
      'discovery/images/abc.png',
      'design/design.md',
      'design/epics.md',
      'design/meetings/2026-08-06-design-review.md',
      'design/diagrams/architecture.svg',
      'design/diagrams/pr-checks.drawio',
      'demo/concept-demo.html',
      'demo/walkthrough.html',
      '01-what-this-feature-must-do.md',
      '04-stories-showcase.html',
    ];
    expect(selectShareFiles(input)).toEqual(input);
  });

  it('drops transcripts, machine json, backups, previews, tooling and DS_Store', () => {
    expect(selectShareFiles([
      'sources/meeting.vtt',
      'sources/nested/notes.md',
      'discovery/discovery.json',
      'design/design.json',
      'discovery/discovery.json.bak-2026-08-17',
      'design/epics.md.bak-2026-08-17',
      'design/diagrams/pr-checks-preview.png',
      'design/walkthrough-template.html',
      'design/build-walkthrough.py',
      '.DS_Store',
      'discovery/.DS_Store',
      'random-notes.md',            // top-level but not NN-*
      'design/diagrams/notes.txt',  // not svg/drawio
    ])).toEqual([]);
  });

  it('shares the design walkthrough html but never its template or build script', () => {
    expect(selectShareFiles(['design/walkthrough.html', 'design/walkthrough-template.html', 'design/build-walkthrough.py']))
      .toEqual(['design/walkthrough.html']);
  });

  it('keeps input order and does not dedupe', () => {
    expect(selectShareFiles(['demo/b.html', 'design/design.md', 'demo/a.html']))
      .toEqual(['demo/b.html', 'design/design.md', 'demo/a.html']);
  });
});

describe('pickFeatureBranch', () => {
  it('stays when already on a branch for this feature', () => {
    expect(pickFeatureBranch({ id: 100901, current: 'discovery-100901', local: ['main', 'discovery-100901'], remote: [] }))
      .toEqual({ action: 'stay', name: 'discovery-100901' });
  });
  it('prefers a local branch over a remote one', () => {
    expect(pickFeatureBranch({ id: 100901, current: 'main', local: ['feature-100901-x'], remote: ['discovery-100901'] }))
      .toEqual({ action: 'checkout-local', name: 'feature-100901-x' });
  });
  it('tracks a remote branch when only that exists', () => {
    expect(pickFeatureBranch({ id: 100901, current: 'main', local: ['main'], remote: ['main', 'discovery-100901'] }))
      .toEqual({ action: 'track-remote', name: 'discovery-100901' });
  });
  it('creates feature-<id> when nothing matches', () => {
    expect(pickFeatureBranch({ id: 100901, current: 'main', local: ['main'], remote: ['main', 'feature/planning'] }))
      .toEqual({ action: 'create', name: 'feature-100901' });
  });
  it('does not match a different id that merely shares digits', () => {
    expect(pickFeatureBranch({ id: 4266, current: 'main', local: ['discovery-100901'], remote: [] }))
      .toEqual({ action: 'create', name: 'feature-4266' });
  });
});

describe('pickTargetFolder', () => {
  it('reuses an existing folder ending in -<id>', () => {
    expect(pickTargetFolder({ id: 100901, existingDirNames: ['dailies', 'github-cd-100901', 'planning'], featureFolderName: '100901-declarative-cd' }))
      .toEqual({ name: 'github-cd-100901', created: false });
  });
  it('creates <slug>-<id> when none exists', () => {
    expect(pickTargetFolder({ id: 100901, existingDirNames: ['dailies'], featureFolderName: '100901-declarative-cd' }))
      .toEqual({ name: 'declarative-cd-100901', created: true });
  });
  it('falls back to feature-<id> when the feature folder is a bare id', () => {
    expect(pickTargetFolder({ id: 7, existingDirNames: [], featureFolderName: '7' }))
      .toEqual({ name: 'feature-7', created: true });
  });
  it('does not match a longer id with the same suffix digits', () => {
    expect(pickTargetFolder({ id: 639, existingDirNames: ['github-cd-100901'], featureFolderName: '639-x' }))
      .toEqual({ name: 'x-639', created: true });
  });
});

describe('commitMessage', () => {
  it('names the feature and the day', () => {
    expect(commitMessage(100901, '2026-08-17T10:11:12.000Z'))
      .toBe('Update #100901 discovery + design docs from sprintomatic (2026-08-17)');
  });
});

describe('compareUrl', () => {
  it('handles ssh origins', () => {
    expect(compareUrl('git@github.com:acme/team-docs.git', 'discovery-100901'))
      .toBe('https://github.com/acme/team-docs/compare/discovery-100901?expand=1');
  });
  it('handles https origins with and without .git', () => {
    expect(compareUrl('https://github.com/o/r.git', 'b')).toBe('https://github.com/o/r/compare/b?expand=1');
    expect(compareUrl('https://github.com/o/r', 'b')).toBe('https://github.com/o/r/compare/b?expand=1');
  });
  it('returns null for anything else', () => {
    expect(compareUrl('ssh://gitlab.example/x.git', 'b')).toBeNull();
  });
});

describe('isProtectedBranch', () => {
  it('flags main and master only', () => {
    expect(isProtectedBranch('main')).toBe(true);
    expect(isProtectedBranch('master')).toBe(true);
    expect(isProtectedBranch('feature-1')).toBe(false);
  });
});
