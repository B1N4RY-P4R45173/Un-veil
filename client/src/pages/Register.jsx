import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

export default function Register() {
  const { meta } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', displayName: '', password: '' });
  const [captcha, setCaptcha] = useState(null);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadCaptcha = useCallback(() => {
    setAnswer('');
    api.get('/auth/captcha').then(setCaptcha).catch(() => setError('Could not load the CAPTCHA.'));
  }, []);
  useEffect(loadCaptcha, [loadCaptcha]);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/register', { ...form, captchaToken: captcha.token, captchaAnswer: answer });
      navigate(`/verify?email=${encodeURIComponent(form.email.trim().toLowerCase())}`);
    } catch (err) {
      setError(err.message);
      loadCaptcha();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={submit}>
        <h1>Join Unveil</h1>
        <p className="muted">Use your college email. We'll send a code to confirm it's you.</p>
        <label className="field">
          <span>College email</span>
          <input type="email" autoComplete="email" required value={form.email} onChange={set('email')} placeholder="you@college.edu" />
        </label>
        {meta?.colleges?.length > 0 && (
          <details className="hint">
            <summary>Which colleges are on Unveil?</summary>
            <ul>
              {meta.colleges.map((c) => <li key={c.domain}>{c.name} <code>@{c.domain}</code></li>)}
            </ul>
          </details>
        )}
        <label className="field">
          <span>Your name</span>
          <input required minLength={2} maxLength={40} value={form.displayName} onChange={set('displayName')} placeholder="Shown only after a mutual reveal" />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="new-password" required minLength={8} value={form.password} onChange={set('password')} />
          <small className="muted">At least 8 characters, with a letter and a number.</small>
        </label>
        <div className="field">
          <span>Quick check: {captcha?.question || '…'}</span>
          <div className="row">
            <input inputMode="numeric" required value={answer} onChange={(e) => setAnswer(e.target.value)} aria-label="CAPTCHA answer" />
            <button type="button" className="btn btn-ghost btn-sm" onClick={loadCaptcha}>New question</button>
          </div>
        </div>
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary btn-block" disabled={busy || !captcha}>Create account</button>
        <p className="muted center">Already have an account? <Link to="/login">Log in</Link></p>
      </form>
    </div>
  );
}
