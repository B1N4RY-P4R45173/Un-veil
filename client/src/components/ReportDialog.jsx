import { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

export default function ReportDialog({ sessionId, alias, onClose, onDone }) {
  const { meta } = useAuth();
  const [reason, setReason] = useState('harassment');
  const [details, setDetails] = useState('');
  const [alsoBlock, setAlsoBlock] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/reports', { sessionId, reason, details });
      if (alsoBlock) await api.post('/blocks', { sessionId });
      onDone?.({ blocked: alsoBlock });
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal card" onClick={(e) => e.stopPropagation()} onSubmit={submit} aria-label="Report">
        <h2>Report {alias}</h2>
        <p className="muted">A moderator will review the conversation. They won't be told who reported them.</p>
        <label className="field">
          <span>What happened?</span>
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            {(meta?.reportReasons || ['harassment', 'spam', 'other']).map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Details (optional)</span>
          <textarea rows={3} maxLength={1000} value={details} onChange={(e) => setDetails(e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={alsoBlock} onChange={(e) => setAlsoBlock(e.target.checked)} />
          Also block them so we never match you again
        </label>
        {error && <p className="error">{error}</p>}
        <div className="row-end">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" disabled={busy}>Send report</button>
        </div>
      </form>
    </div>
  );
}
