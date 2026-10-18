import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';

// The model's strongest signal for a message, e.g. "insult 98%".
function topSignal(moderation) {
  const scores = moderation?.scores;
  if (!scores) return null;
  const [label, p] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0] || [];
  return p >= 0.3 ? `${label.replace('_', ' ')} ${Math.round(p * 100)}%` : null;
}

const when = (d) => new Date(d).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
const TABS = ['Overview', 'Reports', 'Users', 'Colleges', 'Audit log'];

function Overview() {
  const [s, setS] = useState(null);
  useEffect(() => {
    const load = () => api.get('/admin/stats').then(setS).catch(() => {});
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);
  if (!s) return <p className="muted">Loading…</p>;
  const tiles = [
    ['Open reports', s.open_reports, s.open_reports > 0 ? 'bad' : ''],
    ['Online now', s.online],
    ['Waiting to match', s.waiting],
    ['Live chats', s.live_chats],
    ['Chats (24h)', s.chats_24h],
    ['Reveals (24h)', s.reveals_24h],
    ['Messages (24h)', s.messages_24h],
    ['Blocked by moderation (24h)', s.blocked_messages_24h],
    ['Students', s.students],
    ['Suspended or banned', s.restricted],
  ];
  return (
    <div className="tiles">
      {tiles.map(([label, value, tone]) => (
        <div className={`card tile ${tone ? `tile-${tone}` : ''}`} key={label}>
          <div className="tile-value">{value}</div>
          <div className="muted small">{label}</div>
        </div>
      ))}
    </div>
  );
}

function ReportDetail({ id, onResolved }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [note, setNote] = useState('');
  const load = useCallback(() => api.get(`/admin/reports/${id}`).then(setData), [id]);
  useEffect(() => {
    load();
  }, [load]);

  const resolve = async (action) => {
    try {
      await api.post(`/admin/reports/${id}/resolve`, { action, note });
      toast(`Report ${action === 'dismiss' ? 'dismissed' : 'resolved'}.`);
      onResolved();
    } catch (err) {
      toast(err.message, 'warn');
    }
  };
  const remove = async (mid) => {
    try {
      await api.del(`/admin/messages/${mid}`);
      load();
    } catch (err) {
      toast(err.message, 'warn');
    }
  };

  if (!data) return <div className="card"><p className="muted">Loading…</p></div>;
  const { report: r, transcript } = data;
  return (
    <div className="card stack">
      <div>
        <h3>{r.reason} <span className={`pill sev-${r.severity}`}>{r.severity}</span> <span className="pill">{r.source === 'ai' ? 'AI moderation' : 'User report'}</span></h3>
        <p className="small">
          Reported: <strong>{r.reported_name}</strong> ({r.reported_email}){r.reporter_name && <> · by {r.reporter_name}</>} · {when(r.created_at)}
        </p>
        {r.details && <p className="quote">{r.details}</p>}
      </div>
      <div className="transcript">
        {transcript.length === 0 && <p className="muted small">No messages in this conversation.</p>}
        {transcript.map((m) => (
          <div key={m.id} className={`t-line ${m.from_reported ? 't-reported' : ''} ${m.blocked ? 't-blocked' : ''}`}>
            <span className="muted small">{m.from_reported ? 'Reported user' : 'Other'}</span>
            <span className="t-body">{m.deleted ? <em>removed</em> : m.body}</span>
            {topSignal(m.moderation) && <span className="pill" title="Toxicity model score">{topSignal(m.moderation)}</span>}
            {m.blocked && <span className="pill sev-medium">blocked</span>}
            {!m.deleted && <button className="btn btn-link btn-sm" onClick={() => remove(m.id)}>Delete</button>}
          </div>
        ))}
      </div>
      {r.status === 'open' ? (
        <>
          <label className="field">
            <span>Note (optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          </label>
          <div className="row">
            <button className="btn btn-ghost" onClick={() => resolve('dismiss')}>Dismiss</button>
            <button className="btn btn-accent" onClick={() => resolve('warn')}>Warn</button>
            <button className="btn btn-danger" onClick={() => resolve('suspend')}>Suspend</button>
            <button className="btn btn-danger" onClick={() => resolve('ban')}>Ban</button>
          </div>
        </>
      ) : (
        <p className="muted small">Resolved as <strong>{r.status}</strong>{r.admin_note && `: ${r.admin_note}`}</p>
      )}
    </div>
  );
}

function Reports() {
  const [status, setStatus] = useState('open');
  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState(null);
  const load = useCallback(() => api.get(`/admin/reports?status=${status}`).then(setRows), [status]);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <div className="split">
      <div className="stack">
        <select value={status} onChange={(e) => { setStatus(e.target.value); setSelected(null); }} aria-label="Report status">
          {['open', 'all', 'dismissed', 'warned', 'suspended', 'banned'].map((s) => <option key={s}>{s}</option>)}
        </select>
        {rows.length === 0 && <p className="muted">Nothing here.</p>}
        {rows.map((r) => (
          <button key={r.id} className={`card report-row ${selected === r.id ? 'selected' : ''}`} onClick={() => setSelected(r.id)}>
            <span className={`pill sev-${r.severity}`}>{r.severity}</span>
            <span className="grow">
              <strong>{r.reported_name}</strong> · {r.reason}
              <span className="muted small block">{r.source === 'ai' ? 'AI moderation' : 'User report'} · {when(r.created_at)}</span>
            </span>
          </button>
        ))}
      </div>
      <div>{selected ? <ReportDetail key={selected} id={selected} onResolved={() => { setSelected(null); load(); }} /> : <p className="muted">Pick a report to review its conversation.</p>}</div>
    </div>
  );
}

function Users() {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const load = useCallback(() => api.get(`/admin/users?q=${encodeURIComponent(q)}`).then(setRows), [q]);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);
  const setStatus = async (id, status) => {
    try {
      await api.post(`/admin/users/${id}/status`, { status });
      load();
    } catch (err) {
      toast(err.message, 'warn');
    }
  };
  return (
    <div className="stack">
      <input placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search users" />
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Name</th><th>Email</th><th>College</th><th>Status</th><th>Trust</th><th>Warnings</th><th>Reports</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id}>
                <td>{u.display_name}{u.role === 'admin' && <span className="pill">admin</span>}</td>
                <td>{u.email}</td>
                <td>{u.college || '—'}</td>
                <td><span className={`pill status-${u.status}`}>{u.status}</span></td>
                <td>{u.trust_score}</td>
                <td>{u.warnings}</td>
                <td>{u.reports}</td>
                <td className="nowrap">
                  {u.role !== 'admin' && (u.status === 'active' ? (
                    <>
                      <button className="btn btn-link btn-sm" onClick={() => setStatus(u.id, 'suspended')}>Suspend</button>
                      <button className="btn btn-link btn-sm danger" onClick={() => setStatus(u.id, 'banned')}>Ban</button>
                    </>
                  ) : u.status !== 'pending' && (
                    <button className="btn btn-link btn-sm" onClick={() => setStatus(u.id, 'active')}>Reinstate</button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Colleges() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ name: '', emailDomain: '' });
  const load = () => api.get('/admin/colleges').then(setRows);
  useEffect(() => {
    load();
  }, []);
  const add = async (e) => {
    e.preventDefault();
    try {
      await api.post('/admin/colleges', form);
      setForm({ name: '', emailDomain: '' });
      load();
    } catch (err) {
      toast(err.message, 'warn');
    }
  };
  return (
    <div className="stack">
      <form className="card row wrap" onSubmit={add}>
        <input required placeholder="College name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input required placeholder="Email domain, e.g. college.edu" value={form.emailDomain} onChange={(e) => setForm({ ...form, emailDomain: e.target.value })} />
        <button className="btn btn-primary">Add college</button>
      </form>
      <div className="table-wrap">
        <table>
          <thead><tr><th>College</th><th>Email domain</th><th>Students</th></tr></thead>
          <tbody>{rows.map((c) => <tr key={c.id}><td>{c.name}</td><td><code>@{c.email_domain}</code></td><td>{c.students}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

function Audit() {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    api.get('/admin/audit').then(setRows);
  }, []);
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>When</th><th>Action</th><th>Actor</th><th>IP</th><th>Details</th></tr></thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <td className="nowrap">{when(a.created_at)}</td>
              <td><code>{a.action}</code></td>
              <td>{a.actor || '—'}</td>
              <td>{a.ip || '—'}</td>
              <td className="small mono">{Object.keys(a.meta).length ? JSON.stringify(a.meta) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Admin() {
  const [tab, setTab] = useState('Overview');
  return (
    <div className="page wide">
      <h1>Moderation dashboard</h1>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'tab-on' : ''}`} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      {tab === 'Overview' && <Overview />}
      {tab === 'Reports' && <Reports />}
      {tab === 'Users' && <Users />}
      {tab === 'Colleges' && <Colleges />}
      {tab === 'Audit log' && <Audit />}
    </div>
  );
}
