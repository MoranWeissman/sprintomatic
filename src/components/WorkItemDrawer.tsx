import { useEffect, useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import {
  useWorkItem,
  postWorkItemBlock,
  postWorkItemUnblock,
  type ApiWorkItemDetail,
  type ApiWorkItemRef,
  type ApiWorkItemComment,
} from '../lib/api';
import { Mono } from './Mono';

// ADO descriptions arrive in two flavors: HTML (from rich-text editing) and
// markdown (when something — or someone — writes it that way). markdown-it
// with html:true preserves HTML blocks, parses markdown to HTML, and the
// result is then DOMPurified for safety. Single pipeline, no detection.
const md = new MarkdownIt({ html: true, linkify: true, breaks: false });

interface WorkItemDrawerProps {
  /** ADO id of the item to show. Null = drawer closed. */
  itemId: string | null;
  onClose: () => void;
  /** Click handler for related/child/parent refs — opens them in the drawer. */
  onNavigate: (id: string) => void;
}

export function WorkItemDrawer({ itemId, onClose, onNavigate }: WorkItemDrawerProps) {
  const { state, refresh } = useWorkItem(itemId);

  // Close on Esc
  useEffect(() => {
    if (!itemId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [itemId, onClose]);

  if (!itemId) return null;

  return (
    <>
      <div className="ember-drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside
        className="ember-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={state.status === 'ok' ? `Work item ${state.data.item.id}` : 'Work item'}
      >
        <header className="ember-drawer-head">
          <span className="dim-small">
            {state.status === 'ok' ? state.data.item.type.toUpperCase() : 'WORK ITEM'}
            &nbsp;·&nbsp;
            <Mono>#{itemId}</Mono>
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {state.status === 'ok' && <BlockButton item={state.data.item} onChanged={refresh} />}
            <button className="ember-sync" onClick={refresh} title="Refresh from Azure DevOps">
              <span className="ember-sync-icon">↻</span>
            </button>
            <button className="ember-drawer-close" onClick={onClose} aria-label="Close (Esc)">
              ✕
            </button>
          </span>
        </header>

        <div className="ember-drawer-body">
          {state.status === 'loading' && <DrawerLoading />}
          {state.status === 'error' && <DrawerError error={state.error} />}
          {state.status === 'ok' && (
            <DrawerContent
              item={state.data.item}
              comments={state.data.comments}
              onNavigate={onNavigate}
            />
          )}
        </div>
      </aside>
    </>
  );
}

function DrawerLoading() {
  return (
    <div className="ember-drawer-loading">
      <span className="dim-small">loading from azure devops…</span>
    </div>
  );
}

function DrawerError({ error }: { error: string }) {
  return (
    <div className="ember-drawer-error">
      <h3 className="ember-drawer-section-title">Couldn't load this work item</h3>
      <p className="dim">{error}</p>
    </div>
  );
}

function DrawerContent({
  item,
  comments,
  onNavigate,
}: {
  item: ApiWorkItemDetail;
  comments: ApiWorkItemComment[];
  onNavigate: (id: string) => void;
}) {
  return (
    <>
      {/* Title + metadata */}
      <h2 className="ember-drawer-title">{item.title}</h2>

      <div className="ember-drawer-meta">
        <MetaPill label="State" value={item.state} accent />
        {item.assignedTo && <MetaPill label="Assigned to" value={item.assignedTo} />}
        <MetaPill label="Iteration" value={lastSegment(item.iterationPath)} />
        <MetaPill label="Area" value={lastSegment(item.areaPath)} />
        {item.priority != null && <MetaPill label="Priority" value={String(item.priority)} />}
        {item.tags && <MetaPill label="Tags" value={item.tags} />}
      </div>

      {/* Effort numbers */}
      {(item.originalEstimate != null ||
        item.completedWork != null ||
        item.remainingWork != null) && (
        <div className="ember-drawer-effort">
          <EffortBlock label="logged" value={item.completedWork ?? 0} accent />
          <EffortBlock label="estimate" value={item.originalEstimate ?? 0} dim />
          <EffortBlock label="remaining" value={item.remainingWork ?? 0} dim />
        </div>
      )}

      {/* Parent */}
      {item.parent && (
        <Section title="Parent">
          <RefRow item={item.parent} onNavigate={onNavigate} />
        </Section>
      )}

      {/* Description */}
      {item.description && (
        <Section title="Description">
          <SafeHtml html={item.description} />
        </Section>
      )}

      {/* Acceptance criteria / repro steps */}
      {item.acceptanceCriteria && (
        <Section title="Acceptance criteria">
          <SafeHtml html={item.acceptanceCriteria} />
        </Section>
      )}
      {item.reproSteps && (
        <Section title="Repro steps">
          <SafeHtml html={item.reproSteps} />
        </Section>
      )}

      {/* Children (sub-tasks) */}
      {item.children.length > 0 && (
        <Section title={`${item.children.length} child item${item.children.length === 1 ? '' : 's'}`}>
          <div className="ember-drawer-refs">
            {item.children.map(c => (
              <RefRow key={c.id} item={c} onNavigate={onNavigate} />
            ))}
          </div>
        </Section>
      )}

      {/* Related links */}
      {item.related.length > 0 && (
        <Section title="Related">
          <div className="ember-drawer-refs">
            {item.related.map(r => (
              <RefRow key={`${r.id}-${r.rel}`} item={r} onNavigate={onNavigate} />
            ))}
          </div>
        </Section>
      )}

      {/* Comments */}
      {comments.length > 0 && (
        <Section title={`${comments.length} comment${comments.length === 1 ? '' : 's'}`}>
          <div className="ember-drawer-comments">
            {comments.map(c => (
              <article key={c.id} className="ember-drawer-comment">
                <header>
                  <span className="ember-drawer-comment-author">{c.createdBy ?? 'Someone'}</span>
                  <time className="dim-small">{formatTimestamp(c.createdDate)}</time>
                </header>
                <SafeHtml html={c.text} />
              </article>
            ))}
          </div>
        </Section>
      )}

      {/* Footer */}
      <footer className="ember-drawer-foot">
        <span className="dim-small">
          Created <Mono>{formatTimestamp(item.createdDate)}</Mono>
          {item.createdBy && <> by <Mono>{item.createdBy}</Mono></>}
          &nbsp;·&nbsp;
          Updated <Mono>{formatTimestamp(item.changedDate)}</Mono>
          {item.changedBy && <> by <Mono>{item.changedBy}</Mono></>}
        </span>
        <a
          className="ember-drawer-open"
          href={item.webUrl}
          target="_blank"
          rel="noreferrer"
        >
          edit in Azure DevOps <span aria-hidden="true">↗</span>
        </a>
      </footer>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="ember-drawer-section">
      <h3 className="ember-drawer-section-title">{title}</h3>
      {children}
    </section>
  );
}

function RefRow({ item, onNavigate }: { item: ApiWorkItemRef; onNavigate: (id: string) => void }) {
  return (
    <button className="ember-drawer-ref" onClick={() => onNavigate(String(item.id))}>
      <Mono className="ember-drawer-ref-id">#{item.id}</Mono>
      <span className="ember-drawer-ref-title">{item.title}</span>
      <span className="ember-drawer-ref-meta dim-small">
        {item.type}
        {item.state && ` · ${item.state}`}
      </span>
    </button>
  );
}

function MetaPill({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <span className={`ember-drawer-pill ${accent ? 'accent' : ''}`}>
      <span className="dim-small">{label}</span>
      &nbsp;{value}
    </span>
  );
}

function EffortBlock({
  label,
  value,
  accent,
  dim,
}: {
  label: string;
  value: number;
  accent?: boolean;
  dim?: boolean;
}) {
  const h = Math.floor(value);
  const m = Math.round((value - h) * 60);
  return (
    <div className="ember-drawer-effort-block">
      <Mono className={dim ? 'dim' : accent ? 'accent' : undefined}>
        {h}h{m > 0 && ` ${String(m).padStart(2, '0')}m`}
      </Mono>
      <span className="dim-small">{label}</span>
    </div>
  );
}

function SafeHtml({ html }: { html: string }) {
  const clean = useMemo(() => {
    // Render through markdown-it first so markdown bodies become real HTML.
    // HTML inputs pass through (html:true), then DOMPurify enforces the
    // tag/attr allow-list.
    const rendered = md.render(html);
    return DOMPurify.sanitize(rendered, {
      ALLOWED_TAGS: [
        'p', 'div', 'span', 'br', 'hr',
        'strong', 'em', 'b', 'i', 'u', 'code', 'pre',
        'ul', 'ol', 'li',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'a', 'img',
        'table', 'thead', 'tbody', 'tr', 'th', 'td',
        'blockquote',
      ],
      ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'target', 'rel'],
    });
  }, [html]);
  return (
    <div
      className="ember-drawer-html"
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}

// Only Task and User Story have a Blocked state in this tenant. A Bug has none
// (transitionToBlocked would throw), so the button is hidden for everything else.
const BLOCKABLE_TYPES = new Set(['task', 'user story']);

function isBlockedNow(state: string, tags?: string): boolean {
  const s = state.trim().toLowerCase();
  if (s === 'blocked' || s === 'on hold') return true;
  if (tags && tags.split(';').some(t => t.trim().toLowerCase() === 'blocked')) return true;
  return false;
}

function BlockButton({ item, onChanged }: { item: ApiWorkItemDetail; onChanged: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!BLOCKABLE_TYPES.has(item.type.trim().toLowerCase())) return null;

  const blocked = isBlockedNow(item.state, item.tags);

  async function toggle() {
    setPending(true);
    setError(null);
    try {
      if (blocked) await postWorkItemUnblock(String(item.id));
      else await postWorkItemBlock(String(item.id));
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="ember-drawer-block">
      {error && <span className="ember-block-error dim-small">{error}</span>}
      <button
        className={`ember-block-btn ${blocked ? 'is-blocked' : ''}`}
        onClick={toggle}
        disabled={pending}
        title={blocked ? 'Clear the block in Azure DevOps' : 'Mark blocked in Azure DevOps'}
      >
        {pending ? '…' : blocked ? 'Unblock' : 'Block'}
      </button>
    </span>
  );
}

function lastSegment(path: string): string {
  return path.split('\\').pop() ?? path;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
