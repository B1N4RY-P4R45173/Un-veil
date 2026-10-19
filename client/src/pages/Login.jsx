import { useState } from 'react';
import MicrosoftButton from '../components/MicrosoftButton.jsx';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

// Reasons the Microsoft sign-in can send someone back here.
const MS_ERRORS = {
  not_college: 'That Microsoft account is not from a college on Unveil. Use your college account.',
  not_allowed: 'That Microsoft account is not from a college on Unveil. Use your college account.',
  no_email: 'Microsoft did not share your college email. Try again or use email sign-in.',
  not_student: 'Admin accounts sign in with email and password.',
  suspended: 'Your account is suspended while a moderator reviews it.',
  banned: 'This account has been banned for breaking the community guidelines.',
  deleted: 'This account was deleted.',
  ms_consent: 'Your college needs to approve Unveil before you can sign in with Microsoft. Use email sign-in for now.',
  ms_cancelled: 'Microsoft sign-in was cancelled.',
  ms_failed: 'Microsoft sign-in did not work. Please try again.',
  ms_off: 'Microsoft sign-in is not available right now.',
};

export default function Login() {
  const { refresh, meta } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(() => {
    const code = new URLSearchParams(location.search).get('error');
    return code ? { message: MS_ERRORS[code] || MS_ERRORS.ms_failed } : null;
  });
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/login', { email, password });
      await refresh();
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={submit}>
        <h1>Welcome back</h1>
        {meta?.microsoftLogin && (
          <>
            <MicrosoftButton label="Sign in with Microsoft" />
            <div className="or">or use your email</div>
          </>
        )}
        <label className="field">
          <span>College email</span>
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && (
          <p className="error">
            {error.message}{' '}
            {error.body?.needsVerification && <Link to={`/verify?email=${encodeURIComponent(email)}`}>Enter your code</Link>}
          </p>
        )}
        <button className="btn btn-primary btn-block" disabled={busy}>Log in</button>
        <p className="muted center"><Link to={`/reset${email ? `?email=${encodeURIComponent(email)}` : ''}`}>Forgot your password?</Link></p>
        <p className="muted center">New here? <Link to="/register">Create an account</Link></p>
      </form>
    </div>
  );
}
