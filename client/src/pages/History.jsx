import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';
import ReportDialog from '../components/ReportDialog.jsx';

const when = (d) => new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export default function History() {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [blocks, setBlocks] = useState([]);
  const [reporting, setReporting] = useState(null);

  const load = useCallback(() => {
    api.get('/sessions').then(setRows).catch((e) => toast(e.message, 'warn'));
    api.get('/blocks').then(setBlocks).catch(() => {});
  }, [toast]);
  useEffect(load, [load]);

  const act = async (fn, msg) => {
    try {
      await fn();
      toast(msg);
      load();
    } catch (err) {
      toast(err.message, 'warn');
    }
  };

  return (
    <div className="page">
      <h1>Recent conversations</h1>
      <p className="muted">You can report or block someone after a chat ends too.</p>
      {rows === null ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="card empty">No conversations yet. Head to Connect to meet someone.</div>
      ) : (
        <div className="list">
          {rows.map((r) => (
            <div className="card list-row" key={r.id}>
              <div>
                <strong>{r.partnerName || r.partnerAlias}</strong>
                {r.partnerName && <span className="muted small"> ({r.partnerAlias})</span>}
                <div className="muted small">
                  {r.mode === 'campus' ? 'Campus' : 'Cross Campus'} · {when(r.startedAt)} · {r.endedAt ? (r.revealed ? 'Revealed' : 'Stayed anonymous') : 'In progress'}
                </div>
              </div>
              <div className="row">
                {r.revealed && !r.friendship && !r.blocked && (
                  <button className="btn btn-ghost btn-sm" onClick={() => act(() => api.post('/friends/requests', { sessionId: r.id }), 'Friend request sent.')}>Add friend</button>
                )}
                {r.friendship === 'pending' && <span className="pill">Request pending</span>}
                {r.friendship === 'accepted' && <span className="pill pill-good">Friends</span>}
                {r.reported ? <span className="pill">Reported</span> : (
                  <button className="btn btn-ghost btn-sm" onClick={() => setReporting(r)}>Report</button>
                )}
                {r.blocked ? <span className="pill pill-bad">Blocked</span> : (
                  <button className="btn btn-ghost btn-sm" onClick={() => act(() => api.post('/blocks', { sessionId: r.id }), 'Blocked.')}>Block</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {blocks.length > 0 && (
        <>
          <h2 className="sub">Blocked</h2>
          <div className="list">
            {blocks.map((b) => (
              <div className="card list-row" key={b.sessionId}>
                <span>{b.name || b.alias}</span>
                <button className="btn btn-ghost btn-sm" onClick={() => act(() => api.del(`/blocks/${b.sessionId}`), 'Unblocked.')}>Unblock</button>
              </div>
            ))}
          </div>
        </>
      )}
      {reporting && (
        <ReportDialog
          sessionId={reporting.id}
          alias={reporting.partnerName || reporting.partnerAlias}
          onClose={() => setReporting(null)}
          onDone={() => {
            toast('Thanks. A moderator will review it.');
            load();
          }}
        />
      )}
    </div>
  );
}
