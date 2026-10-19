import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../toast.jsx';

export default function Reset() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [email, setEmail] = useState(params.get('email') || '');
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = (fn) => async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const request = run(async () => {
    await api.post('/auth/forgot', { email });
    setSent(true);
  });

  const reset = run(async () => {
    await api.post('/auth/reset', { email, code, password });
    toast('Password changed. Log in with your new password.');
    navigate('/login', { replace: true });
  });

  return (
    <div className="auth-page">
      {!sent ? (
        <form className="card auth-card" onSubmit={request}>
          <h1>Reset your password</h1>
          <p className="muted">Enter your college email and we'll send you a code.</p>
          <label className="field">
            <span>College email</span>
            <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="btn btn-primary btn-block" disabled={busy}>Send code</button>
          <p className="muted center"><Link to="/login">Back to log in</Link></p>
        </form>
      ) : (
        <form className="card auth-card" onSubmit={reset}>
          <h1>Choose a new password</h1>
          <p className="muted">If {email} has an Unveil account, a 6-digit code is on its way. Check your junk or spam folder too.</p>
          <label className="field">
            <span>Code</span>
            <input inputMode="numeric" autoComplete="one-time-code" required pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.trim())} />
          </label>
          <label className="field">
            <span>New password</span>
            <input type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
            <small className="muted">At least 8 characters, with a letter and a number.</small>
          </label>
          {error && <p className="error">{error}</p>}
          <button className="btn btn-primary btn-block" disabled={busy}>Change password</button>
          <p className="muted center">
            <button type="button" className="btn-link" onClick={() => { setSent(false); setCode(''); }}>Use a different email</button>
          </p>
        </form>
      )}
    </div>
  );
}
