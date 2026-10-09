import { useCallback, useEffect, useState } from 'react';
import {
  fetchDiscoveryList, fetchDiscoveryDoc, fetchDiscoveryBoard, markDiscoveryDemo, openDiscoveryFolder, fetchDesign,
  type ApiFeatureSection, type ApiFeatureListEntry, type DiscoveryDocPayload, type DiscoveryBoardPayload,
  type ApiDiscoveryChild, type ApiDiscoveryMeeting, type ApiDiscoveryTag, type DndStatus,
  type DesignPayload, type ApiDesignDoc,
} from '../lib/api';
import type { DndPage } from '../lib/pages';

const STATUS_LABEL: Record<DndStatus, string> = {
  'in-progress': 'In progress',
  'not-started': 'Not started',
  'closed': 'Done',
};

type Facet = DndPage['facets'][number];
type DiscoverySub = 'review' | 'meetings' | 'walkthrough' | 'demo';
type DesignSub = 'review' | 'meetings' | 'walkthrough';

/** Render a displayName's **bold** span without showing raw asterisks. */
function renderDisplayName(s: string): JSX.Element {
  const m = s.match(/^\*\*(.+?)\*\*\s*(.*)$/);
  if (!m) return <span>{s}</span>;
  return <span><strong>{m[1]}</strong> {m[2]}</span>;
}

/** Drop ~~struck~~ runs — they're the old version of an edited spec, noise for
 *  "what this feature is now" — then tidy the whitespace the removal leaves. */
function stripStruck(s: string): string {
  return s.replace(/~~[^~]+~~/g, '').replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
}

/** Inline markup in board text: **bold** and ![alt](url) images. The server
 *  rewrites downloadable ADO images to a local /api/discovery/<id>/image/ URL,
 *  which we show as a real <img>. Anything still remote (couldn't download) or
 *  non-ADO falls back to a muted caption — a raw remote src would just break. */
function renderInline(s: string): (string | JSX.Element)[] {
  return stripStruck(s)
    .split(/(\*\*[^*]+\*\*|!\[[^\]]*\]\([^)]+\))/g)
    .filter(part => part !== '')
    .map((part, i) => {
      if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
      const img = part.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (img) {
        const [, alt, url] = img;
        if (url.startsWith('/api/discovery/')) {
          return (
            <a key={i} className="dnd-img-link" href={url} target="_blank" rel="noreferrer">
              <img className="dnd-img" src={url} alt={alt || 'board image'} loading="lazy" />
            </a>
          );
        }
        return <span key={i} className="dnd-fig">🖼 {alt || 'image on the board'}</span>;
      }
      return part;
    });
}

/* --- Board description: numbered **N. Title** headers become collapsible
   sections; paragraphs and bullet lists render as themselves. --- */

type DescBlock = { kind: 'para'; lines: string[] } | { kind: 'list'; items: string[] };
interface DescSection { heading: string | null; blocks: DescBlock[] }

/** A block that is exactly one **bold** run on its own line is a section header. */
const DESC_HEADER = /^\*\*(.+?)\*\*$/;

function parseDescription(text: string): DescSection[] {
  const sections: DescSection[] = [];
  let cur: DescSection = { heading: null, blocks: [] };
  let para: string[] = [];
  let items: string[] = [];

  const flushPara = () => { if (para.length) { cur.blocks.push({ kind: 'para', lines: para }); para = []; } };
  const flushList = () => { if (items.length) { cur.blocks.push({ kind: 'list', items }); items = []; } };
  const pushSection = () => { if (cur.heading !== null || cur.blocks.length) sections.push(cur); };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') { flushPara(); continue; }      // blank ends a paragraph, keeps a list open
    const header = line.match(DESC_HEADER);
    // Drop the author's leading "N." — each topic is its own card, the number is noise.
    if (header) { flushPara(); flushList(); pushSection(); cur = { heading: header[1].replace(/^\d+\.\s*/, ''), blocks: [] }; continue; }
    if (/^[-*]\s+/.test(line)) { flushPara(); items.push(line.replace(/^[-*]\s+/, '')); continue; }
    flushList(); para.push(line);
  }
  flushPara(); flushList(); pushSection();
  return sections;
}

/** A bullet like "**Label:** long text" becomes its own collapsible sub-topic:
 *  the label is the summary, the body hides until opened. Closed by default —
 *  same approach as the sections above it. Plain bullets stay a simple row. */
function renderListItem(item: string, key: number): JSX.Element {
  const m = item.match(/^\*\*(.+?):\*\*\s*(.+)$/s);
  if (m) {
    return (
      <details key={key} className="dnd-sub">
        <summary className="dnd-sub-sum">
          <span className="dnd-group-chev" aria-hidden="true" />
          <span className="dnd-sub-label">{stripStruck(m[1])}</span>
        </summary>
        <div className="dnd-sub-body">{renderInline(m[2])}</div>
      </details>
    );
  }
  return <div key={key} className="dnd-ov-li">{renderInline(item)}</div>;
}

function renderDescBlock(b: DescBlock, i: number): JSX.Element {
  if (b.kind === 'list') {
    return <div key={i} className="dnd-subs">{b.items.map((it, j) => renderListItem(it, j))}</div>;
  }
  return (
    <p key={i} className="dnd-ov-p">
      {b.lines.map((ln, j) => <span key={j}>{j > 0 && <br />}{renderInline(ln)}</span>)}
    </p>
  );
}

function renderDescription(text: string): JSX.Element {
  const sections = parseDescription(text);
  return (
    <>
      {sections.map((sec, i) => {
        if (sec.heading === null) {
          return <div key={i} className="dnd-ov-intro">{sec.blocks.map(renderDescBlock)}</div>;
        }
        // Closed by default — you open the topic you want to read.
        return (
          <details key={i} className="dnd-group">
            <summary className="dnd-group-sum">
              <span className="dnd-group-chev" aria-hidden="true" />
              <span className="dnd-group-name">{stripStruck(sec.heading)}</span>
            </summary>
            <div className="dnd-ov-body">{sec.blocks.map(renderDescBlock)}</div>
          </details>
        );
      })}
    </>
  );
}

const DISCOVERY_SUBS: DiscoverySub[] = ['review', 'meetings', 'walkthrough', 'demo'];
const DESIGN_SUBS: DesignSub[] = ['review', 'meetings', 'walkthrough'];

/** Read the open feature + facet + discovery/design sub-tab from the URL so a
 *  refresh restores them. Both facets share the one `?sub=` param — only one
 *  of `sub`/`designSub` is ever meaningful at a time, based on `facet`. */
function readUrlState(page: DndPage): { id: number | null; facet: Facet; sub: DiscoverySub; designSub: DesignSub } {
  if (typeof window === 'undefined') return { id: null, facet: page.firstFacet, sub: 'review', designSub: 'review' };
  const p = new URL(window.location.href).searchParams;
  const rawId = Number(p.get('feature'));
  const id = Number.isInteger(rawId) && rawId > 0 ? rawId : null;
  const f = p.get('facet');
  const s = p.get('sub');
  return {
    id,
    facet: page.facets.includes(f as Facet) ? (f as Facet) : page.firstFacet,
    sub: DISCOVERY_SUBS.includes(s as DiscoverySub) ? (s as DiscoverySub) : 'review',
    designSub: DESIGN_SUBS.includes(s as DesignSub) ? (s as DesignSub) : 'review',
  };
}

export function DnDView({ page, onOpenItem }: { page: DndPage; onOpenItem?: (id: string) => void }): JSX.Element {
  const [sections, setSections] = useState<ApiFeatureSection[] | null>(null);
  const initial = readUrlState(page);
  const [selectedId, setSelectedId] = useState<number | null>(initial.id);
  const [facet, setFacet] = useState<Facet>(initial.facet);
  const [sub, setSub] = useState<DiscoverySub>(initial.sub);
  const [designSub, setDesignSub] = useState<DesignSub>(initial.designSub);
  // Design's Meetings sub-tab hint lives in the pinned head (DesignSubBar),
  // sitting outside DesignFacet — so the raw meetings array (not a pre-reduced
  // count) is lifted here, same shape as Discovery's `doc.meetings`, and the
  // count is computed inline where it's used. DesignFacet clears this on the
  // very same effect tick where it clears its own payload (keyed on
  // featureId), so there's no separate reset to remember on any path
  // (feature switch, facet switch, or browser back/forward) — one effect,
  // one place data can go stale, and it can't.
  const [designMeetings, setDesignMeetings] = useState<ApiDiscoveryMeeting[]>([]);
  // Disk-backed doc (Discovery/Demo) and board data (Overview) load separately,
  // so a slow board never stalls the doc that's sitting ready on disk.
  const [doc, setDoc] = useState<DiscoveryDocPayload | null>(null);
  const [board, setBoard] = useState<DiscoveryBoardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(() => {
    setError(null);
    fetchDiscoveryList()
      .then(p => setSections(Array.isArray(p?.sections) ? p.sections : []))
      .catch(e => setError(String(e)));
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

  const loadDoc = useCallback(() => {
    if (selectedId == null) { setDoc(null); setBoard(null); return; }
    setError(null);
    // Clear the old feature's data first so the reading area shows "Loading…"
    // instead of feature A's content under feature B while B loads.
    setDoc(null);
    setBoard(null);
    // Two independent requests. The doc is disk-only and returns instantly;
    // the board hits ADO and may lag — it fills the Overview when it arrives.
    fetchDiscoveryDoc(selectedId).then(setDoc).catch(e => setError(String(e)));
    fetchDiscoveryBoard(selectedId).then(setBoard).catch(() => setBoard({ reachable: false, children: [] }));
  }, [selectedId]);

  useEffect(() => { loadDoc(); }, [loadDoc]);

  // Keep the URL in step with what's open, so a refresh (or a shared link)
  // lands back on the same feature + facet instead of the feature list.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedId == null) {
      url.searchParams.delete('feature'); url.searchParams.delete('facet'); url.searchParams.delete('sub');
    } else {
      url.searchParams.set('feature', String(selectedId));
      url.searchParams.set('facet', facet);
      if (facet === 'discovery') url.searchParams.set('sub', sub);
      else if (facet === 'design') url.searchParams.set('sub', designSub);
      else url.searchParams.delete('sub');
    }
    window.history.replaceState(null, '', url.toString());
  }, [selectedId, facet, sub, designSub]);

  // Back/forward should move between features too.
  useEffect(() => {
    const handler = () => {
      const s = readUrlState(page);
      setSelectedId(s.id); setFacet(s.facet); setSub(s.sub); setDesignSub(s.designSub);
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, [page]);

  // Feature-list collapse, kept in localStorage so a refresh doesn't undo it.
  // Same key shape as the Daily page's two side panels.
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('sh.dnd.rail.collapsed') === '1';
  });
  useEffect(() => {
    window.localStorage.setItem('sh.dnd.rail.collapsed', railCollapsed ? '1' : '0');
  }, [railCollapsed]);

  function selectFeature(id: number): void {
    setSelectedId(id);
    setFacet(page.firstFacet);
    setSub('review'); // land on the data view, not a "not built yet" HTML sub-tab
    setDesignSub('review');
  }

  // Clicking into the Design tab always lands on Review, same reasoning as
  // selectFeature above — never strand the user on a sub-tab from a
  // different feature or a different visit.
  function pickFacet(f: Facet): void {
    if (f === 'design' && facet !== 'design') setDesignSub('review');
    setFacet(f);
  }

  // A switch flipped in Settings while a now-hidden tab was open.
  useEffect(() => {
    if (!page.facets.includes(facet)) setFacet(page.firstFacet);
  }, [page, facet]);

  function goHome(): void {
    setSelectedId(null);
  }

  const selectedName =
    sections?.flatMap(s => s.features).find(f => f.id === selectedId)?.displayName ?? `#${selectedId}`;

  // No feature open → full-width browser so the whole page is used.
  if (selectedId == null) {
    return <FeatureBrowser page={page} sections={sections} error={error} onSelect={selectFeature} />;
  }

  // A feature is open → feature list on the left, facet tabs on top of a
  // full-width reading area (frees the old 184px menu column for reading).
  return (
    <div className="dnd">
      <FeatureListRail
        page={page}
        sections={sections}
        selectedId={selectedId}
        error={error}
        onSelect={selectFeature}
        onBack={goHome}
        collapsed={railCollapsed}
        onToggleCollapsed={() => setRailCollapsed(v => !v)}
      />
      <div className="dnd-main">
        <FeatureFacetBar facets={page.facets} facet={facet} onPick={pickFacet} />
        <FacetReadingArea
          facet={facet}
          sub={sub}
          onSub={setSub}
          designSub={designSub}
          onDesignSub={setDesignSub}
          designMeetings={designMeetings}
          onDesignMeetings={setDesignMeetings}
          featureId={selectedId}
          displayName={selectedName}
          doc={doc}
          board={board}
          error={error}
          onReloadDoc={loadDoc}
          onOpenItem={onOpenItem}
        />
      </div>
    </div>
  );
}

/** Feature meta chips — shared by the browser cards and the reading-view rail rows. */
function FeatureMeta(props: { feature: ApiFeatureListEntry }): JSX.Element {
  const { feature: f } = props;
  return (
    <span className="dnd-row-meta">
      {f.boardState && <span className={`dnd-chip is-${f.boardState.toLowerCase()}`}>{f.boardState}</span>}
      {f.readyToClose && <span className="dnd-ready">ready to close</span>}
      {f.dayLabel && <span className="dnd-day">{f.dayLabel}</span>}
    </span>
  );
}

/** Compact rail row — used inside the three-level reading view. */
function FeatureRow(props: {
  feature: ApiFeatureListEntry;
  selected: boolean;
  onSelect: (id: number) => void;
}): JSX.Element {
  const { feature: f, selected, onSelect } = props;
  return (
    <button className={`dnd-row${selected ? ' is-sel' : ''}`} onClick={() => onSelect(f.id)}>
      <span className="dnd-row-name">{renderDisplayName(f.displayName)}</span>
      <FeatureMeta feature={f} />
    </button>
  );
}

/* ------------------- Landing — full-width feature browser ----------------- */

/** A roomy card for the landing grid, with a status-colored spine. */
function FeatureCard(props: {
  feature: ApiFeatureListEntry;
  onSelect: (id: number) => void;
}): JSX.Element {
  const { feature: f, onSelect } = props;
  return (
    <button className={`dnd-card is-${f.dndStatus}`} onClick={() => onSelect(f.id)}>
      <span className="dnd-card-name">{renderDisplayName(f.displayName)}</span>
      <FeatureMeta feature={f} />
      <span className="dnd-card-go" aria-hidden="true">Read discovery →</span>
    </button>
  );
}

/** Plain-word noun for the running summary line, e.g. "3 in progress". */
const STATUS_NOUN: Record<DndStatus, string> = {
  'in-progress': 'in progress',
  'not-started': 'not started',
  'closed': 'done',
};

function FeatureBrowser(props: {
  page: DndPage;
  sections: ApiFeatureSection[] | null;
  error: string | null;
  onSelect: (id: number) => void;
}): JSX.Element {
  const { page, sections, error, onSelect } = props;
  const groups = sections?.filter(sec => sec.features.length > 0) ?? [];
  const total = groups.reduce((n, s) => n + s.features.length, 0);
  const summary = groups.map(s => `${s.features.length} ${STATUS_NOUN[s.status]}`).join(' · ');

  return (
    <main className="dnd-browse">
      <header className="dnd-browse-head">
        <div className="dnd-browse-cap">{page.label}</div>
        <h1 className="dnd-browse-h">Your features</h1>
        {total > 0
          ? <p className="dnd-browse-sub"><b>{summary}</b> — pick one to read its {page.reads}.</p>
          : <p className="dnd-browse-sub">One place per feature for its {page.reads}.</p>}
      </header>

      {error && <div className="dnd-error">Couldn't load discoveries: {error}</div>}
      {sections && total === 0 && !error && (
        <div className="dnd-empty">
          Discoveries show up here once you start one. Run <code>/sprintomatic:discovery</code> in a workspace to begin.
        </div>
      )}

      {groups.map(sec => (
        <section key={sec.status} className={`dnd-browse-grp is-${sec.status}`}>
          <div className="dnd-browse-grp-head">
            <span className="dnd-browse-grp-dot" />
            <span className="dnd-browse-grp-label">{STATUS_LABEL[sec.status]}</span>
            <span className="dnd-browse-grp-count">{sec.features.length}</span>
          </div>
          <div className="dnd-browse-grid">
            {sec.features.map(f => (
              <FeatureCard key={f.id} feature={f} onSelect={onSelect} />
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}

/* ------------------------- Level 1 — feature list ------------------------- */

function FeatureListRail(props: {
  page: DndPage;
  sections: ApiFeatureSection[] | null;
  selectedId: number | null;
  error: string | null;
  onSelect: (id: number) => void;
  onBack: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}): JSX.Element {
  const { page, sections, selectedId, error, onSelect, onBack, collapsed, onToggleCollapsed } = props;

  // Collapsed, the rail is a 32px strip. It keeps the way BACK to the feature
  // browser — that button lives nowhere else, and hiding the only way out
  // behind "expand first" is not a trade worth making for the extra width.
  if (collapsed) {
    return (
      <div className="dnd-railwrap is-collapsed">
        <div className="dnd-rail-strip">
          <button
            type="button"
            className="dnd-rail-icon"
            onClick={onToggleCollapsed}
            title="Show the feature list"
            aria-label="Show the feature list"
          >
            <span className="dnd-rail-chev" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="dnd-rail-icon"
            onClick={onBack}
            title="All features"
            aria-label="All features"
          >
            <span className="dnd-rail-back-arrow" aria-hidden="true">←</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="dnd-railwrap">
      <aside className="dnd-rail">
      <div className="dnd-rail-top">
        <button className="dnd-rail-back" onClick={onBack}>
          <span className="dnd-rail-back-arrow" aria-hidden="true">←</span> All features
        </button>
        <button
          type="button"
          className="dnd-rail-icon"
          onClick={onToggleCollapsed}
          title="Hide the feature list"
          aria-label="Hide the feature list"
        >
          <span className="dnd-rail-chev" aria-hidden="true" />
        </button>
      </div>
      <div className="dnd-rail-title">{page.label}</div>
      <div className="dnd-rail-sub">Features you've worked</div>
      {error && <div className="dnd-error">Couldn't load discoveries: {error}</div>}
      {sections && sections.length === 0 && (
        <div className="dnd-empty">
          Discoveries show up here once you start one. Run <code>/sprintomatic:discovery</code> in a workspace to begin.
        </div>
      )}
      {sections?.map(sec => (
        <div key={sec.status} className={`dnd-grp is-${sec.status}`}>
          <div className="dnd-grp-head">
            {STATUS_LABEL[sec.status]} <span className="dnd-grp-count">{sec.features.length}</span>
          </div>
          {sec.features.map(f => (
            <FeatureRow key={f.id} feature={f} selected={f.id === selectedId} onSelect={onSelect} />
          ))}
        </div>
      ))}
      </aside>
    </div>
  );
}

/* ------------------------- Level 2 — facet tab bar ------------------------ */

function FeatureFacetBar(props: {
  facets: Facet[];
  facet: Facet;
  onPick: (f: Facet) => void;
}): JSX.Element {
  const { facets, facet, onPick } = props;
  const LABEL: Record<Facet, string> = { overview: 'Overview', discovery: 'Discovery', design: 'Design' };
  const tabs: { id: Facet; label: string; hint?: string }[] = facets.map(id => ({ id, label: LABEL[id] }));
  return (
    <nav className="dnd-tabbar" role="tablist" aria-label="This feature">
      {tabs.map(t => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === facet}
          className={`dnd-tabtop${t.id === facet ? ' is-sel' : ''}`}
          onClick={() => onPick(t.id)}
        >
          <span className="dnd-tabtop-label">{t.label}</span>
          {t.hint && <span className="dnd-tabtop-hint">{t.hint}</span>}
        </button>
      ))}
    </nav>
  );
}

/* ------------------------- Level 3 — reading area ------------------------- */

/** The feature's folder on disk: the path (click to copy) + an Open button.
 *  Lives under the title so it's there on every tab, not hidden in Demo. */
function FolderLine(props: { featureId: number; folderPath: string }): JSX.Element {
  const { featureId, folderPath } = props;
  const [copied, setCopied] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(folderPath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard blocked — the path is still visible to select */ });
  };
  return (
    <div className="dnd-folder">
      <span className="dnd-folder-lab">Folder</span>
      <button type="button" className="dnd-folder-path" onClick={copy} title="Click to copy the path">
        {folderPath}
      </button>
      <span className="dnd-folder-actions">
        <button type="button" className="dnd-folder-btn" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        <button
          type="button"
          className="dnd-folder-btn"
          onClick={() => openDiscoveryFolder(featureId).then(r => setOpenFailed(!r.ok)).catch(() => setOpenFailed(true))}
        >
          Open
        </button>
        {openFailed && <span className="dnd-folder-note">couldn't open it — copy the path instead</span>}
      </span>
    </div>
  );
}

function FacetReadingArea(props: {
  facet: Facet;
  sub: DiscoverySub;
  onSub: (s: DiscoverySub) => void;
  designSub: DesignSub;
  onDesignSub: (s: DesignSub) => void;
  designMeetings: ApiDiscoveryMeeting[];
  onDesignMeetings: (m: ApiDiscoveryMeeting[]) => void;
  featureId: number;
  displayName: string;
  doc: DiscoveryDocPayload | null;
  board: DiscoveryBoardPayload | null;
  error: string | null;
  onReloadDoc: () => void;
  onOpenItem?: (id: string) => void;
}): JSX.Element {
  const {
    facet, sub, onSub, designSub, onDesignSub, designMeetings, onDesignMeetings,
    featureId, displayName, doc, board, error, onReloadDoc, onOpenItem,
  } = props;

  if (error) {
    return <main className="dnd-read"><div className="dnd-read-scroll"><div className="dnd-error">Couldn't read this feature: {error}</div></div></main>;
  }
  if (!doc) {
    return <main className="dnd-read"><div className="dnd-read-scroll"><div className="dnd-loading">Loading…</div></div></main>;
  }

  // The head (title + sub-tabs) stays pinned; only the content below scrolls.
  // The scroller is keyed by facet+sub so every tab click starts its page
  // from the top instead of inheriting the previous tab's scroll depth.
  return (
    <main className="dnd-read">
      <div className="dnd-read-head">
        <h1 className="dnd-read-title">{renderDisplayName(displayName)}</h1>
        <FolderLine featureId={featureId} folderPath={doc.folderPath} />
        {facet === 'discovery' && (
          <DiscoverySubBar
            sub={sub}
            onSub={onSub}
            demoStatus={doc.doc?.demo.status ?? 'none'}
            meetingCount={(doc.meetings ?? []).length}
          />
        )}
        {facet === 'design' && (
          <DesignSubBar sub={designSub} onSub={onDesignSub} meetingCount={(designMeetings ?? []).length} />
        )}
      </div>
      <div className="dnd-read-scroll" key={`${facet}:${facet === 'design' ? designSub : sub}`}>
        {facet === 'overview' && <OverviewFacet board={board} onOpenItem={onOpenItem} />}
        {facet === 'discovery' && (
          <DiscoveryFacet
            sub={sub}
            featureId={featureId}
            payload={doc}
            onReloadDoc={onReloadDoc}
          />
        )}
        {facet === 'design' && (
          <DesignFacet sub={designSub} featureId={featureId} onMeetings={onDesignMeetings} />
        )}
      </div>
    </main>
  );
}

function OverviewFacet(props: { board: DiscoveryBoardPayload | null; onOpenItem?: (id: string) => void }): JSX.Element {
  const { board, onOpenItem } = props;
  // Board hasn't arrived yet — the ADO call is still in flight.
  if (!board) return <div className="dnd-loading">Reading the board…</div>;
  if (!board.reachable) {
    return <p className="dnd-muted">Couldn't reach the board — Overview needs Azure DevOps. Discovery still reads fine.</p>;
  }
  return (
    <div className="dnd-overview">
      {board.featureState && (
        <div className="dnd-overview-state">
          <span className={`dnd-chip is-${board.featureState.toLowerCase()}`}>{board.featureState}</span>
        </div>
      )}
      <h2 className="dnd-h2">What this feature is</h2>
      {board.featureDescription
        ? <div className="dnd-ov-desc">{renderDescription(board.featureDescription)}</div>
        : <p className="dnd-muted">No description on the board.</p>}
      <h2 className="dnd-h2">Stories &amp; tasks under this feature</h2>
      {board.children.length === 0
        ? <p className="dnd-muted">Nothing linked under this feature yet.</p>
        : (
          <ul className="dnd-kids">
            {board.children.map((c: ApiDiscoveryChild) => (
              <li key={c.id} className={`dnd-kid is-${(c.state || '').toLowerCase()}`}>
                <button
                  type="button"
                  className="dnd-kid-btn"
                  onClick={() => onOpenItem?.(String(c.id))}
                  disabled={!onOpenItem}
                >
                  <span className="dnd-kid-type">{c.type}</span>
                  <span className="dnd-kid-title">{c.title} <span className="dnd-kid-id">#{c.id}</span></span>
                  {c.state && <span className="dnd-kid-state">{c.state}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

/** An item can carry several tags; the spine colour follows the most important
 *  one — a risk outranks a dependency, which outranks a change; a mitigation
 *  is calmer than all three; then an option, then a plain fact. */
function dominantTag(tags: ApiDiscoveryTag[]): string {
  for (const t of ['risk', 'dep', 'diff', 'mitigation', 'option', 'fact'] as const) if (tags.includes(t)) return t;
  return 'fact';
}

/** Long items are collapsed to a few lines so a group isn't a wall of text;
 *  a "Show more" toggle reveals the rest. Short items render whole, no toggle. */
const ITEM_CLAMP_CHARS = 240;

/** Display words for tag chips — plain English instead of the raw tag string.
 *  Display only: the CSS class name still uses the raw tag. */
const TAG_LABEL: Record<string, string> = { dep: 'waits on', mitigation: 'answer' };

function ContextItem(props: { item: { text: string; tags: ApiDiscoveryTag[] } }): JSX.Element {
  const { item } = props;
  const isLong = item.text.length > ITEM_CLAMP_CHARS;
  const [open, setOpen] = useState(false);
  return (
    <li className={`dnd-item is-${dominantTag(item.tags)}`}>
      <span className="dnd-item-main">
        <span className={`dnd-item-text${isLong && !open ? ' is-clamped' : ''}`}>{item.text}</span>
        {isLong && (
          <button className="dnd-item-more" onClick={() => setOpen(o => !o)}>
            {open ? 'Show less' : 'Show more'}
          </button>
        )}
      </span>
      <span className="dnd-item-tags">
        {item.tags.map(t => <span key={t} className={`dnd-tag is-${t}`}>{TAG_LABEL[t] ?? t}</span>)}
      </span>
    </li>
  );
}

function DiscoverySubBar(props: {
  sub: DiscoverySub;
  onSub: (s: DiscoverySub) => void;
  demoStatus: 'none' | 'scheduled' | 'built';
  meetingCount: number;
}): JSX.Element {
  const { sub, onSub, demoStatus, meetingCount } = props;
  const tabs: { id: DiscoverySub; label: string; hint?: string }[] = [
    { id: 'review', label: 'Review' },
    { id: 'meetings', label: 'Meetings', hint: meetingCount > 0 ? String(meetingCount) : undefined },
    { id: 'walkthrough', label: 'Walkthrough' },
    { id: 'demo', label: 'Demo', hint: demoStatus === 'none' ? undefined : demoStatus },
  ];
  return (
    <nav className="dnd-subtabs" role="tablist" aria-label="Discovery views">
      {tabs.map(t => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === sub}
          className={`dnd-subtab${t.id === sub ? ' is-sel' : ''}`}
          onClick={() => onSub(t.id)}
        >
          {t.label}
          {t.hint && <span className="dnd-subtab-hint">{t.hint}</span>}
        </button>
      ))}
    </nav>
  );
}

/** Design's sub-tab strip — same anatomy as DiscoverySubBar, minus the Demo
 *  tab (Design has no demo of its own) and minus a hint on Walkthrough (it's
 *  just enabled or not, no status word to show). */
function DesignSubBar(props: {
  sub: DesignSub;
  onSub: (s: DesignSub) => void;
  meetingCount: number;
}): JSX.Element {
  const { sub, onSub, meetingCount } = props;
  const tabs: { id: DesignSub; label: string; hint?: string }[] = [
    { id: 'review', label: 'Review' },
    { id: 'meetings', label: 'Meetings', hint: meetingCount > 0 ? String(meetingCount) : undefined },
    { id: 'walkthrough', label: 'Walkthrough' },
  ];
  return (
    <nav className="dnd-subtabs" role="tablist" aria-label="Design views">
      {tabs.map(t => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === sub}
          className={`dnd-subtab${t.id === sub ? ' is-sel' : ''}`}
          onClick={() => onSub(t.id)}
        >
          {t.label}
          {t.hint && <span className="dnd-subtab-hint">{t.hint}</span>}
        </button>
      ))}
    </nav>
  );
}

/** The sub-tab STRIP renders in the pinned read-head (FacetReadingArea);
 *  this component is only the active sub-tab's content. */
function DiscoveryFacet(props: {
  sub: DiscoverySub;
  featureId: number;
  payload: DiscoveryDocPayload;
  onReloadDoc: () => void;
}): JSX.Element {
  const { sub, featureId, payload, onReloadDoc } = props;
  // Defensive: a payload from an older server (dev server started before the
  // meetings field shipped, or a cached response) has no `meetings` — render
  // an empty list instead of crashing the whole facet.
  const meetings = payload.meetings ?? [];
  return (
    <div className="dnd-discovery-wrap">
      {sub === 'review' && <DiscoveryReview doc={payload.doc} />}
      {sub === 'meetings' && <MeetingsFacet meetings={meetings} />}
      {sub === 'walkthrough' && (
        payload.hasWalkthrough
          ? <ArtifactView featureId={featureId} kind="walkthrough" title="Discovery walkthrough" />
          : <p className="dnd-artifact-empty">No walkthrough built yet. In a Claude Code chat, ask to build the walkthrough slideshow.</p>
      )}
      {sub === 'demo' && (
        <DemoFacet
          featureId={featureId}
          doc={payload.doc}
          hasDemoHtml={payload.hasDemoHtml}
          onSaved={onReloadDoc}
        />
      )}
    </div>
  );
}

/** Split a text into its first sentence and the rest (rest null when the
 *  whole text is one sentence). The design skill's writing rule makes the
 *  first sentence work alone — the UI leans on that for folding. */
function splitLead(s: string): { lead: string; rest: string | null } {
  const m = s.match(/^(.+?[.!?])\s+(.+)$/s);
  return m ? { lead: m[1], rest: m[2] } : { lead: s, rest: null };
}

/** Bold the first sentence of a long text row so the eye catches each row's
 *  point without reading it all. A single-sentence row renders unchanged. */
function leadSentence(s: string): JSX.Element {
  const { lead, rest } = splitLead(s);
  if (rest === null) return <>{lead}</>;
  return <><strong>{lead}</strong> {rest}</>;
}

/** First sentence only, with a "show more" button that reveals the rest.
 *  One-sentence texts render plain — nothing to fold. */
function FoldableText(props: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const { lead, rest } = splitLead(props.text);
  if (rest === null) return <p className="dnd-fold-lead">{lead}</p>;
  return (
    <div className="dnd-fold">
      <p className="dnd-fold-lead">
        {lead}
        {!open && (
          <button type="button" className="dnd-fold-btn" onClick={() => setOpen(true)}>show more</button>
        )}
      </p>
      {open && (
        <>
          <p className="dnd-fold-rest">{rest}</p>
          <button type="button" className="dnd-fold-btn" onClick={() => setOpen(false)}>show less</button>
        </>
      )}
    </div>
  );
}

/** The agree-per-part state of one Discovery card. Calm: the ✓ is quiet
 *  sage, the absence is muted text — never an alarm. */
function AgreedMark(props: { on: boolean }): JSX.Element {
  return props.on
    ? <span className="dnd-agreed is-on">agreed ✓</span>
    : <span className="dnd-agreed">not agreed yet</span>;
}

function DiscoveryReview(props: { doc: DiscoveryDocPayload['doc'] }): JSX.Element {
  const { doc } = props;
  if (!doc) return <div className="dnd-empty">This feature has no discovery yet.</div>;
  const agreed = doc.agreed ?? [];
  const pushback = doc.pushback ?? [];
  const mark = (key: string) => <AgreedMark on={agreed.includes(key)} />;
  return (
    <div className="dnd-discovery">
      <div className="dnd-problem">
        {doc.problem || '—'}
        {doc.problem.trim() !== '' && mark('problem')}
      </div>

      {pushback.length > 0 && (
        <>
          <h2 className="dnd-h2">What we don't accept as-is {mark('pushback')}</h2>
          <p className="dnd-section-note">Things in this feature we question — to raise with the product side before designing. Never blocks the work.</p>
          <ul className="dnd-push">{pushback.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </>
      )}

      <h2 className="dnd-h2">The feature end-to-end {doc.flow.length > 0 && mark('flow')}</h2>
      <ol className="dnd-flow">{doc.flow.map((s, i) => <li key={i}>{s}</li>)}</ol>

      <h2 className="dnd-h2">Context groups</h2>
      {doc.groups.map((g, gi) => (
        <details key={gi} className="dnd-group">
          <summary className="dnd-group-sum">
            <span className="dnd-group-chev" aria-hidden="true" />
            <span className="dnd-group-name">{g.name}</span>
            {g.items.length > 0 && <AgreedMark on={agreed.includes(`group:${g.name}`)} />}
            <span className="dnd-group-count">{g.items.length}</span>
          </summary>
          <ul className="dnd-items">
            {g.items.map((it, ii) => <ContextItem key={ii} item={it} />)}
          </ul>
        </details>
      ))}

      <h2 className="dnd-h2">Lanes {(doc.lanes.ours.trim() !== '' || doc.lanes.techLead.trim() !== '') && mark('lanes')}</h2>
      <div className="dnd-lanes">
        <div className="dnd-lane">
          <div className="dnd-lane-lab">Ours</div>
          <p>{doc.lanes.ours || '—'}</p>
        </div>
        <div className="dnd-lane">
          <div className="dnd-lane-lab">Tech lead's</div>
          <p>{doc.lanes.techLead || '—'}</p>
        </div>
      </div>

      <h2 className="dnd-h2">Open questions {doc.openQuestions.length > 0 && mark('openQuestions')}</h2>
      <p className="dnd-section-note">Still unanswered — your agenda for the talk with the platform team.</p>
      {doc.openQuestions.length === 0
        ? <p className="dnd-muted">None noted.</p>
        : <ul className="dnd-qs">{doc.openQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul>}
    </div>
  );
}

/** The Meetings sub-tab: one collapsible card per discovery meeting, newest
 *  first, in the Review cards' style. The files on disk are the record; the
 *  dashboard only shows them. */
function MeetingsFacet(props: { meetings: ApiDiscoveryMeeting[] }): JSX.Element {
  const { meetings } = props;
  if (meetings.length === 0) {
    return (
      <p className="dnd-artifact-empty">
        No meeting summaries yet. Tell your work chat about a meeting and it will land here.
      </p>
    );
  }
  return (
    <div className="dnd-meetings">
      {meetings.map(m => (
        <details key={m.file} className="dnd-group">
          <summary className="dnd-group-sum">
            <span className="dnd-group-chev" aria-hidden="true" />
            {m.date && <span className="dnd-meeting-date">{m.date}</span>}
            <span className="dnd-group-name">{m.title}</span>
          </summary>
          <div className="dnd-ov-body">{renderDescription(m.body)}</div>
        </details>
      ))}
    </div>
  );
}

/** The active Design sub-tab's content (the sub-tab STRIP itself renders in
 *  the pinned read-head above, via DesignSubBar). Design's payload is
 *  disk-backed like Discovery's, but it's fetched right here instead of
 *  lifted to DnDView — the Design facet is the only reader of it. The
 *  Meetings-tab hint in the pinned head needs the raw meetings array, though,
 *  so it's reported upward on the SAME effect tick that clears/refills this
 *  component's own payload — one effect, keyed on featureId, so there's no
 *  second reset to remember on any path (feature switch, facet switch, or
 *  browser back/forward all just change featureId or unmount this component;
 *  either way the lifted array can't outlive the feature it belongs to). */
function DesignFacet(props: {
  sub: DesignSub;
  featureId: number;
  onMeetings: (m: ApiDiscoveryMeeting[]) => void;
}): JSX.Element {
  const { sub, featureId, onMeetings } = props;
  const [payload, setPayload] = useState<DesignPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPayload(null);
    setError(null);
    onMeetings([]); // clear the previous feature's meetings the instant featureId changes
    fetchDesign(featureId)
      .then(p => { setPayload(p); onMeetings(p.meetings ?? []); })
      .catch(e => setError(String(e)));
    // onMeetings is a useState setter (setDesignMeetings) — its identity is
    // stable across renders, so it's safe to depend on here.
  }, [featureId, onMeetings]);

  if (error) return <div className="dnd-error">Couldn't read the design: {error}</div>;
  if (!payload) return <div className="dnd-loading">Loading…</div>;

  const meetings = payload.meetings ?? [];
  const diagrams = payload.diagrams ?? [];

  return (
    <div className="dnd-discovery-wrap">
      {sub === 'review' && <DesignReview doc={payload.doc ?? null} problem={payload.problem ?? ''} diagrams={diagrams} featureId={featureId} />}
      {sub === 'meetings' && <MeetingsFacet meetings={meetings} />}
      {sub === 'walkthrough' && (
        payload.hasWalkthrough
          ? <ArtifactView featureId={featureId} kind="design-walkthrough" title="Design walkthrough" />
          : <p className="dnd-artifact-empty">No design walkthrough built yet. In a Claude Code chat, ask to build the design walkthrough.</p>
      )}
    </div>
  );
}

/** The gate-progress line + the design doc's sections, in review order:
 *  approach → flows → stories → working plan → open decisions. Same
 *  collapsible-card and AgreedMark anatomy as DiscoveryReview. */
function DesignReview(props: { doc: ApiDesignDoc | null; problem: string; diagrams: string[]; featureId: number }): JSX.Element {
  const { doc, problem, diagrams, featureId } = props;
  if (!doc) {
    return (
      <div className="dnd-placeholder">
        <p className="dnd-muted">This feature has no design yet.</p>
        <p className="dnd-muted-2">In a Claude Code chat, say "start the design".</p>
      </div>
    );
  }

  const agreed = doc.agreed ?? [];
  const mark = (key: string) => <AgreedMark on={agreed.includes(key)} />;

  const approachPresent = doc.approach.lines.length > 0 || doc.approach.diagram.trim() !== '';
  const flowsPresent = doc.flows.length > 0;
  const planPresent = doc.plan.length > 0;
  const decisionsPresent = doc.decisions.length > 0;

  // Same present-parts logic as the server's designAgreementCheck: every
  // non-empty part plus every story needs its key in `agreed` to count.
  const outOfScope = doc.outOfScope ?? [];
  const parts = [
    { key: 'approach', present: approachPresent },
    { key: 'outOfScope', present: outOfScope.length > 0 },
    { key: 'flows', present: flowsPresent },
    ...doc.stories.map(s => ({ key: `story:${s.title}`, present: true })),
    { key: 'plan', present: planPresent },
    { key: 'decisions', present: decisionsPresent },
  ];
  const presentParts = parts.filter(p => p.present);
  const agreedCount = presentParts.filter(p => agreed.includes(p.key)).length;
  const pushedLabel = doc.pushed.storyIds.length > 0 ? String(doc.pushed.storyIds.length) : 'not yet';

  const diagramImg = (name: string, alt = 'architecture picture') =>
    diagrams.includes(name)
      ? <img src={`/api/discovery/${featureId}/diagram/${name}`} className="dnd-diagram" alt={alt} />
      : null;

  // Each part is one collapsible card, closed by default — the page opens as
  // five calm rows (same rule as the Discovery cards: the user decides what
  // to open). The count chip on a closed card says how much is inside.
  const partCard = (
    label: string,
    markNode: JSX.Element | false | null,
    count: number | null,
    body: JSX.Element,
  ) => (
    <details className="dnd-group">
      <summary className="dnd-group-sum">
        <span className="dnd-group-chev" aria-hidden="true" />
        <span className="dnd-group-name">{label}</span>
        {markNode}
        {count !== null && <span className="dnd-group-count">{count}</span>}
      </summary>
      <div className="dnd-ov-body">{body}</div>
    </details>
  );

  return (
    <div className="dnd-discovery">
      <p className="dnd-section-note">
        Parts agreed: {agreedCount} of {presentParts.length} · review: {doc.review.status} · stories pushed: {pushedLabel}
      </p>

      {problem.trim() !== '' && (
        <div className="dnd-problem dnd-design-intro">
          <span className="dnd-kicker">What this is about — the need, from the discovery</span>
          {problem}
        </div>
      )}

      {doc.approach.diagram && diagramImg(doc.approach.diagram) && (
        <details open className="dnd-group dnd-bigpic">
          <summary className="dnd-group-sum">
            <span className="dnd-group-chev" aria-hidden="true" />
            <span className="dnd-group-name">The big picture</span>
          </summary>
          <div className="dnd-ov-body">
            {diagramImg(doc.approach.diagram)}
          </div>
        </details>
      )}

      {partCard('The approach', approachPresent && mark('approach'), doc.approach.lines.length, (
        doc.approach.lines.length > 0
          ? (
            <ul className="dnd-items">
              {doc.approach.lines.map((l, i) => (
                <li key={i} className="dnd-item"><span className="dnd-item-main">{leadSentence(l)}</span></li>
              ))}
            </ul>
          )
          : <p className="dnd-muted">Not filled in yet.</p>
      ))}

      {outOfScope.length > 0 && partCard('Not in this design', mark('outOfScope'), outOfScope.length, (
        <ul className="dnd-items">
          {outOfScope.map((x, i) => (
            <li key={i} className="dnd-item"><span className="dnd-item-main">{leadSentence(x)}</span></li>
          ))}
        </ul>
      ))}

      {partCard('The flows', flowsPresent && mark('flows'), doc.flows.length, (
        doc.flows.length === 0
          ? <p className="dnd-muted">None yet.</p>
          : <>
              {doc.flows.map((f, fi) => (
                <details key={fi} className="dnd-sub">
                  <summary className="dnd-sub-sum">
                    <span className="dnd-group-chev" aria-hidden="true" />
                    <span className="dnd-sub-label">{f.name}</span>
                  </summary>
                  <div className="dnd-sub-body">
                    <ol className="dnd-flow">{f.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
                    {f.diagram && diagramImg(f.diagram, f.name)}
                  </div>
                </details>
              ))}
            </>
      ))}

      {partCard('The stories', null, doc.stories.length, (
        doc.stories.length === 0
          ? <p className="dnd-muted">None yet.</p>
          : <>
              {doc.stories.map((s, si) => (
                <details key={si} className="dnd-sub">
                  <summary className="dnd-sub-sum dnd-story-sum">
                    <span className="dnd-group-chev" aria-hidden="true" />
                    <span className="dnd-story-main">
                      <span className="dnd-sub-label">{s.title}</span>
                      {s.covers.trim() !== '' && (
                        <span className="dnd-story-lead">{splitLead(s.covers).lead}</span>
                      )}
                    </span>
                    <span className="dnd-hours">{s.estimateHours}h</span>
                    <AgreedMark on={agreed.includes(`story:${s.title}`)} />
                  </summary>
                  <div className="dnd-sub-body">
                    <p>{s.covers || '—'}</p>
                    <p className="dnd-muted">Why this estimate: {s.why || '—'}</p>
                  </div>
                </details>
              ))}
            </>
      ))}

      {partCard('The working plan', planPresent && mark('plan'), doc.plan.length, (
        doc.plan.length === 0
          ? <p className="dnd-muted">None yet.</p>
          : (
            <ol className="dnd-flow">
              {doc.plan.map((p, i) => (
                <li key={i}>
                  {p.step}
                  {p.stories.length > 0 && <> — {p.stories.join(', ')}</>}
                  {p.note && <> ({p.note})</>}
                </li>
              ))}
            </ol>
          )
      ))}

      {partCard('Open decisions', decisionsPresent && mark('decisions'), doc.decisions.length, (
        doc.decisions.length === 0
          ? <p className="dnd-muted">None noted.</p>
          : (
            <ul className="dnd-qs">
              {doc.decisions.map((d, i) => (
                <li key={i}>
                  <div className="dnd-q">{d.question}</div>
                  {d.choice
                    ? <FoldableText text={d.choice} />
                    : <p className="dnd-muted">not decided yet</p>}
                </li>
              ))}
            </ul>
          )
      ))}
    </div>
  );
}

/** Shows a session-built HTML artifact in a sealed frame. The sandbox allows
 *  scripts (the demo's animated flow, the slideshow) but NOT same-origin, so the
 *  artifact's loud styling can never leak into the calm dashboard. */
function ArtifactView(props: { featureId: number; kind: 'walkthrough' | 'demo' | 'design-walkthrough'; title: string }): JSX.Element {
  const { featureId, kind, title } = props;
  const url = `/api/discovery/${featureId}/html/${kind}`;
  const downloadName = kind === 'walkthrough' ? 'walkthrough.html'
    : kind === 'design-walkthrough' ? 'design-walkthrough.html' : 'concept-demo.html';
  return (
    <div className="dnd-artifact">
      <div className="dnd-artifact-bar">
        <a className="dnd-btn is-quiet" href={url} target="_blank" rel="noreferrer">Open in new tab</a>
        <a className="dnd-btn is-quiet" href={url} download={downloadName}>Download</a>
      </div>
      <iframe className="dnd-artifact-frame" src={url} title={title} sandbox="allow-scripts" loading="lazy" />
    </div>
  );
}

function DemoFacet(props: {
  featureId: number;
  doc: DiscoveryDocPayload['doc'];
  hasDemoHtml: boolean;
  onSaved: () => void;
}): JSX.Element {
  const { featureId: id, doc, hasDemoHtml, onSaved } = props;
  const [status, setStatus] = useState<'none' | 'scheduled' | 'built'>(doc?.demo.status ?? 'none');
  const [date, setDate] = useState(doc?.demo.date ?? '');

  useEffect(() => {
    setStatus(doc?.demo.status ?? 'none');
    setDate(doc?.demo.date ?? '');
  }, [doc]);

  if (!doc) return <div className="dnd-empty">Start a discovery before marking a demo.</div>;

  return (
    <div className="dnd-demo">
      <h2 className="dnd-h2">Demo candidate</h2>
      {doc.demo.notes
        ? <div className="dnd-demo-candidate">{doc.demo.notes}</div>
        : <p className="dnd-muted">No candidate noted yet. A discovery session jots which flow to demo and why here.</p>}

      <h2 className="dnd-h2">The demo</h2>
      {hasDemoHtml
        ? <ArtifactView featureId={id} kind="demo" title="Concept demo" />
        : <p className="dnd-artifact-empty">No demo built yet. In a Claude Code chat, ask to build the concept demo.</p>}

      <h2 className="dnd-h2">Where the demo stands</h2>
      <div className="dnd-demo-controls">
        <label className="dnd-field">
          <span>Status</span>
          <select value={status} onChange={e => setStatus(e.target.value as 'none' | 'scheduled' | 'built')}>
            <option value="none">none</option>
            <option value="scheduled">scheduled</option>
            <option value="built">built</option>
          </select>
        </label>
        <label className="dnd-field">
          <span>Date</span>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        </label>
        <button className="dnd-btn" onClick={() => markDiscoveryDemo(id, { status, date }).then(onSaved)}>Save</button>
      </div>
    </div>
  );
}
