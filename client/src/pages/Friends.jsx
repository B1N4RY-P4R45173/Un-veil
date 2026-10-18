import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';
import { Tags } from '../components/Chips.jsx';

export default function Friends() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const load = useCallback(() => api.get('/friends').then(setData).catch((e) => toast(e.message, 'warn')), [toast]);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (fn) => {
    try {
      await fn();
      load();
    } catch (err) {
      toast(err.message, 'warn');
    }
  };

  if (!data) return <div className="page"><p className="muted">Loading…</p></div>;
  return (
    <div className="page">
      <h1>Friends</h1>
      {data.incoming.length > 0 && (
        <section>
          <h2 className="sub">Requests</h2>
          <div className="list">
            {data.incoming.map((f) => (
              <div className="card list-row" key={f.id}>
                <div><strong>{f.displayName}</strong> <span className="muted small">{f.college}</span></div>
                <div className="row">
                  <button className="btn btn-primary btn-sm" onClick={() => act(() => api.post(`/friends/requests/${f.id}/accept`))}>Accept</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => act(() => api.post(`/friends/requests/${f.id}/decline`))}>Decline</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
      {data.friends.length === 0 ? (
        <div className="card empty">No friends yet. Reveal in a chat you enjoyed, then add them here.</div>
      ) : (
        <div className="friend-grid">
          {data.friends.map((f) => (
            <div className="card friend" key={f.id}>
              <div className="avatar lg" aria-hidden="true">{f.displayName[0]}</div>
              <h3>{f.displayName}</h3>
              <p className="muted small">{f.college}</p>
              {f.bio && <p className="small">{f.bio}</p>}
              <Tags items={f.interests} />
              <button className="btn btn-link btn-sm" onClick={() => act(() => api.del(`/friends/${f.id}`))}>Remove</button>
            </div>
          ))}
        </div>
      )}
      {data.outgoing.length > 0 && (
        <p className="muted small">Waiting on {data.outgoing.map((f) => f.displayName).join(', ')}.</p>
      )}
    </div>
  );
}
