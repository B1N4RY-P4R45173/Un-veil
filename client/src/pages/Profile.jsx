import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useToast } from '../toast.jsx';
import Chips from '../components/Chips.jsx';

const STANDING = {
  excellent: 'Excellent. You get the best matches.',
  good: 'Good. Keep conversations kind and it will grow.',
  fair: 'Fair. Reports and blocks have lowered it.',
  limited: 'Limited. You are mostly matched with others in the same standing until it recovers.',
};

export default function Profile() {
  const { me, setMe, meta } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const onboarding = useLocation().state?.onboarding || !me.profileComplete;
  const [form, setForm] = useState({ displayName: me.displayName, bio: me.bio, interests: me.interests, personality: me.personality });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setForm({ displayName: me.displayName, bio: me.bio, interests: me.interests, personality: me.personality });
  }, [me]);

  const save = async (e) => {
    e.preventDefault();
    if (!form.interests.length || !form.personality.length) {
      setError('Pick at least one interest and one personality tag. They are how we find your match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const updated = await api.patch('/me', form);
      setMe(updated);
      toast('Profile saved.');
      if (onboarding) navigate('/connect');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page narrow">
      <h1>{onboarding ? 'Tell us a little about you' : 'Your profile'}</h1>
      <p className="muted">
        Before a reveal, your match only sees your interests and personality tags. Your name, college and bio appear only after you both choose to reveal.
      </p>
      <form className="card stack" onSubmit={save}>
        <div className="grid-2">
          <label className="field">
            <span>Name</span>
            <input value={form.displayName} minLength={2} maxLength={40} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </label>
          <div className="field">
            <span>College</span>
            <div className="static">{me.college}</div>
          </div>
        </div>
        <label className="field">
          <span>Bio <small className="muted">({280 - (form.bio?.length || 0)} left)</small></span>
          <textarea rows={2} maxLength={280} value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} placeholder="Shown after a reveal" />
        </label>
        <div className="field">
          <span>Interests <small className="muted">(up to 8)</small></span>
          <Chips options={meta?.interests || []} value={form.interests} max={8} onChange={(interests) => setForm({ ...form, interests })} />
        </div>
        <div className="field">
          <span>Personality <small className="muted">(up to 5)</small></span>
          <Chips options={meta?.personality || []} value={form.personality} max={5} onChange={(personality) => setForm({ ...form, personality })} />
        </div>
        {error && <p className="error">{error}</p>}
        <div className="row-end">
          <button className="btn btn-primary" disabled={busy}>{onboarding ? 'Save and start connecting' : 'Save changes'}</button>
        </div>
      </form>
      {!onboarding && (
        <div className="card standing">
          <h3>Community standing: <span className={`standing-${me.standing}`}>{me.standing}</span></h3>
          <p className="muted">{STANDING[me.standing]}</p>
          {me.warnings > 0 && <p className="warn-text">You have {me.warnings} warning{me.warnings > 1 ? 's' : ''}. Three warnings suspend an account.</p>}
        </div>
      )}
      {!onboarding && <DeleteAccount />}
    </div>
  );
}

function DeleteAccount() {
  const { setMe } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.del('/me', { password });
      setMe(null);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="row-end danger-zone">
        <button className="btn-link danger" onClick={() => setOpen(true)}>Delete my account</button>
      </div>
    );
  }
  return (
    <form className="card stack danger-zone" onSubmit={submit}>
      <h3>Delete your account</h3>
      <p className="muted">
        This removes your profile, messages, friends and blocks, and cannot be undone. People you already revealed to have seen your details.
        Reports about you are kept in anonymous form.
      </p>
      <label className="field">
        <span>Confirm with your password</span>
        <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row-end">
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
        <button className="btn btn-danger" disabled={busy}>Delete account</button>
      </div>
    </form>
  );
}
