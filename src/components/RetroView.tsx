/**
 * Retro — the sprint's own record turned into a first draft.
 *
 * The server reads the board, the session log, the blocks, the estimates and
 * the days off, and proposes lines in three buckets. The user's whole job is
 * keep-or-drop: everything starts kept, one tap drops a line, Save stores the
 * pass. What was kept becomes the cheat sheet for the meeting — and next
 * sprint's page opens with it, so "we said we'd change X" has a follow-up.
 */
import { useEffect, useState } from 'react';
import {
  fetchRetro,
  saveRetroChoices,
  type ApiRetroItem,
  type ApiRetroPayload,
  type RetroBucket,
} from '../lib/api';

type RetroState =
  | { status: 'loading' }
  | { status: 'ok'; data: ApiRetroPayload }
  | { status: 'error'; error: string };

const BUCKETS: { id: RetroBucket; title: string; note: string }[] = [
  { id: 'well', title: 'Went well', note: 'from the board and the log — keep what you want to say' },
  { id: 'way', title: 'Got in the way', note: 'blocks, overruns, work that carries over' },
  { id: 'talk', title: 'Worth saying out loud', note: 'repeats and mid-sprint calls the record noticed' },
];

export function RetroView() {
  const [state, setState] = useState<RetroState>({ status: 'loading' });
  const [decisions, setDecisions] = useState<Record<string, 'keep' | 'drop'>>({});
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchRetro()
      .then(data => {
        if (!alive) return;
        setState({ status: 'ok', data });
        setDecisions(Object.fromEntries(data.items.map(i => [i.key, i.decision])));
      })
      .catch(err => {
        if (!alive) return;
        setState({ status: 'error', error: err instanceof Error ? err.message : 'Could not load the retro' });
      });
    return () => {
      alive = false;
    };
  }, []);

  if (state.status === 'loading') {
    return (
      <div className="retro-page">
        <div className="retro-empty">Reading this sprint's record…</div>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="retro-page">
        <div className="retro-error">{state.error}</div>
      </div>
    );
  }

  const { data } = state;
  const toggle = (key: string) => {
    setDecisions(d => ({ ...d, [key]: d[key] === 'drop' ? 'keep' : 'drop' }));
    setDirty(true);
    setSaveState('idle');
  };

  const save = async () => {
    setSaveState('saving');
    try {
      await saveRetroChoices(
        data.sprintName,
        data.items.map(i => ({
          key: i.key,
          bucket: i.bucket,
          text: i.text,
          decision: decisions[i.key] ?? 'keep',
        })),
      );
      setSaveState('saved');
      setDirty(false);
    } catch {
      setSaveState('failed');
    }
  };

  const keptCount = data.items.filter(i => (decisions[i.key] ?? 'keep') === 'keep').length;

  return (
    <div className="retro-page">
      <header className="retro-head">
        <div>
          <h1 className="retro-h">Retro</h1>
          <p className="retro-sub">{data.sprintLine}</p>
          <p className="retro-sub">A first draft from this sprint's record. Drop what you don't want to bring up — the rest is your list for the retro meeting.</p>
        </div>
        <div className="retro-head-actions">
          <span className="retro-kept">{keptCount} of {data.items.length} lines on your list</span>
          <button
            className="retro-save"
            onClick={() => void save()}
            disabled={saveState === 'saving' || (!dirty && saveState !== 'failed')}
          >
            {saveState === 'saving'
              ? 'Saving…'
              : saveState === 'failed'
                ? 'Save failed — try again'
                : dirty
                  ? 'Save my list'
                  : data.savedAt || saveState === 'saved'
                    ? 'Saved'
                    : 'Save my list'}
          </button>
        </div>
      </header>

      {data.previous && data.previous.kept.length > 0 && (
        <section className="retro-prev">
          <h2 className="retro-prev-title">Last retro (sprint {data.previous.sprintName}) you kept these — did anything change?</h2>
          <ul className="retro-prev-list">
            {data.previous.kept.map((k, i) => (
              <li key={i} className={`retro-prev-item is-${k.bucket}`}>{stripMd(k.text)}</li>
            ))}
          </ul>
        </section>
      )}

      {BUCKETS.map(bucket => {
        const items = data.items.filter(i => i.bucket === bucket.id);
        return (
          <section key={bucket.id} className={`retro-section is-${bucket.id}`}>
            <div className="retro-sec-head">
              <h2 className="retro-sec-title">{bucket.title}</h2>
              <span className="retro-sec-note">{bucket.note}</span>
            </div>
            {items.length === 0 ? (
              <div className="retro-none">Nothing here from this sprint's record.</div>
            ) : (
              <ul className="retro-rows">
                {items.map(item => (
                  <RetroRow
                    key={item.key}
                    item={item}
                    decision={decisions[item.key] ?? 'keep'}
                    onToggle={() => toggle(item.key)}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function RetroRow({
  item,
  decision,
  onToggle,
}: {
  item: ApiRetroItem;
  decision: 'keep' | 'drop';
  onToggle: () => void;
}) {
  return (
    <li className={`retro-row is-${item.bucket}${decision === 'drop' ? ' is-dropped' : ''}`}>
      <div className="retro-row-main">
        <span className="retro-row-text">{renderMd(item.text)}</span>
        <span className="retro-row-evidence">{item.evidence}</span>
      </div>
      <button className="retro-row-toggle" onClick={onToggle}>
        {decision === 'drop' ? 'put back' : 'drop'}
      </button>
    </li>
  );
}

/** The server ships titles as `**Title** (#id)` — render the bold, keep it simple. */
function renderMd(text: string) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return parts.map((p, i) => (i % 2 === 1 ? <strong key={i}>{p}</strong> : <span key={i}>{p}</span>));
}

function stripMd(text: string): string {
  return text.replace(/\*\*/g, '');
}
