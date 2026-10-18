import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { useChat } from '../chat.jsx';
import { useToast } from '../toast.jsx';
import { api } from '../api.js';
import { Tags } from '../components/Chips.jsx';
import ReportDialog from '../components/ReportDialog.jsx';

const MODES = [
  { id: 'campus', title: 'Campus Connect', text: 'Someone from your own college.' },
  { id: 'cross', title: 'Cross Campus', text: 'Someone from a different college.' },
];
const FILTERS = [
  { id: 'interest', title: 'Interests', text: 'Share at least one interest.' },
  { id: 'personality', title: 'Personality', text: 'Share a personality trait.' },
  { id: 'mystery', title: 'Mystery', text: 'No filters. Anyone could appear.' },
];

function useNow(interval = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(t);
  }, [interval]);
  return now;
}

const fmt = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function Setup() {
  const chat = useChat();
  const [mode, setMode] = useState('campus');
  const [filter, setFilter] = useState('interest');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setBusy(true);
    setError('');
    const res = await chat.findMatch(mode, filter);
    if (!res.ok) setError(res.error || 'Could not join the queue.');
    setBusy(false);
  };

  return (
    <div className="page narrow">
      <h1>Who would you like to meet?</h1>
      <div className="choice-group" role="radiogroup" aria-label="Where to look">
        {MODES.map((m) => (
          <button key={m.id} role="radio" aria-checked={mode === m.id} className={`choice ${mode === m.id ? 'choice-on' : ''}`} onClick={() => setMode(m.id)}>
            <strong>{m.title}</strong>
            <span>{m.text}</span>
          </button>
        ))}
      </div>
      <h2 className="sub">Match by</h2>
      <div className="choice-group three" role="radiogroup" aria-label="How to match">
        {FILTERS.map((f) => (
          <button key={f.id} role="radio" aria-checked={filter === f.id} className={`choice ${filter === f.id ? 'choice-on' : ''}`} onClick={() => setFilter(f.id)}>
            <strong>{f.title}</strong>
            <span>{f.text}</span>
          </button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      <button className="btn btn-primary btn-lg btn-block" onClick={go} disabled={busy || !chat.connected}>
        {chat.connected ? 'Find someone' : 'Connecting…'}
      </button>
      <p className="muted small center">Only text and emoji until you both reveal. Contact details are hidden automatically.</p>
    </div>
  );
}

function Waiting() {
  const chat = useChat();
  const now = useNow();
  const waited = now - (chat.waitingSince || now);
  return (
    <div className="page narrow center waiting">
      <div className="pulse" aria-hidden="true"><span /><span /><span /></div>
      <h1>Looking for someone…</h1>
      <p className="muted">Waiting {fmt(waited)}</p>
      {waited > 20000 && <p className="muted">It's quiet right now. Mystery match or Cross Campus usually finds someone faster.</p>}
      <button className="btn btn-ghost" onClick={chat.cancel}>Cancel</button>
    </div>
  );
}

function RevealPanel({ session }) {
  const chat = useChat();
  const toast = useToast();
  const now = useNow();
  const left = new Date(session.safePeriodEndsAt).getTime() - now;
  const progress = Math.min(1, 1 - left / (session.safePeriodSeconds * 1000));

  if (session.revealed) return null;
  const onReveal = async () => {
    const res = await chat.reveal();
    if (!res.ok) toast(res.error, 'warn');
  };
  return (
    <div className="reveal-panel">
      <div className="reveal-bar" aria-hidden="true"><span style={{ width: `${progress * 100}%` }} /></div>
      {left > 0 ? (
        <span className="muted small">Safe period: reveal opens in {fmt(left)}</span>
      ) : session.consent.me ? (
        <span className="small">You chose to reveal. {session.consent.partner ? '' : 'Waiting for them…'}</span>
      ) : (
        <span className="small">{session.consent.partner ? 'They want to reveal. ' : ''}Ready to see who this is?</span>
      )}
      {left <= 0 && !session.consent.me && <button className="btn btn-accent btn-sm" onClick={onReveal}>Reveal me</button>}
    </div>
  );
}

function Revealed({ session, onClose }) {
  const toast = useToast();
  const [sent, setSent] = useState(false);
  const addFriend = async () => {
    try {
      const r = await api.post('/friends/requests', { sessionId: session.id });
      setSent(true);
      toast(r.status === 'accepted' ? 'You are now friends!' : 'Friend request sent.');
    } catch (err) {
      toast(err.message, 'warn');
    }
  };
  return (
    <div className="modal-backdrop">
      <div className="modal card unveil-card" role="dialog" aria-label="Identity revealed">
        <div className="curtain left" aria-hidden="true" />
        <div className="curtain right" aria-hidden="true" />
        <p className="eyebrow">{session.partnerAlias} is</p>
        <h2 className="reveal-name">{session.partner.displayName}</h2>
        <p className="muted">{session.partner.college}</p>
        {session.partner.bio && <p className="reveal-bio">“{session.partner.bio}”</p>}
        <div className="row-center">
          <button className="btn btn-primary" onClick={addFriend} disabled={sent}>{sent ? 'Request sent' : 'Add friend'}</button>
          <button className="btn btn-ghost" onClick={onClose}>Keep chatting</button>
        </div>
      </div>
    </div>
  );
}

function ChatRoom() {
  const { me } = useAuth();
  const chat = useChat();
  const toast = useToast();
  const { session, messages, phase } = chat;
  const [text, setText] = useState('');
  const [reporting, setReporting] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [reported, setReported] = useState(false);
  const [friendSent, setFriendSent] = useState(false);
  const listRef = useRef(null);
  const typingRef = useRef(null);
  const ended = phase === 'ended';

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, chat.partnerTyping]);

  const onType = (e) => {
    setText(e.target.value);
    chat.typing(true);
    clearTimeout(typingRef.current);
    typingRef.current = setTimeout(() => chat.typing(false), 1500);
  };

  const submit = async (e) => {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setText('');
    chat.typing(false);
    const res = await chat.send(body);
    if (!res.ok) {
      toast(res.error, 'warn');
      if (!res.moderated) setText(body);
    }
  };

  const block = async () => {
    try {
      await api.post('/blocks', { sessionId: session.id });
      setBlocked(true);
      toast('Blocked. You will not be matched with them again.');
    } catch (err) {
      toast(err.message, 'warn');
    }
  };

  const addFriend = async () => {
    try {
      const r = await api.post('/friends/requests', { sessionId: session.id });
      setFriendSent(true);
      toast(r.status === 'accepted' ? 'You are now friends!' : 'Friend request sent.');
    } catch (err) {
      toast(err.message, 'warn');
    }
  };

  const shared = {
    interests: session.partnerTags.interests.filter((t) => me.interests.includes(t)),
    personality: session.partnerTags.personality.filter((t) => me.personality.includes(t)),
  };
  const endText = {
    ended: chat.ended?.byYou ? 'You ended the chat.' : 'They ended the chat.',
    disconnected: 'The connection was lost and the chat ended.',
    blocked: chat.ended?.byYou ? 'You blocked them.' : 'The chat ended.',
    moderation: 'This chat was ended by moderation.',
    left: 'They left Unveil.',
  }[chat.ended?.reason] || 'The chat ended.';

  return (
    <div className="chat">
      <header className="chat-head">
        <div className="who">
          <div className="avatar" aria-hidden="true">{session.revealed ? session.partner.displayName[0] : '?'}</div>
          <div>
            <div className="who-name">
              {session.revealed ? session.partner.displayName : session.partnerAlias}
              <span className="badge">{session.mode === 'campus' ? 'Campus' : 'Cross Campus'}</span>
            </div>
            {session.revealed ? (
              <div className="muted small">{session.partner.college}</div>
            ) : (
              <div className="small">
                <Tags items={[...session.partnerTags.interests, ...session.partnerTags.personality]} shared={[...shared.interests, ...shared.personality]} />
              </div>
            )}
          </div>
        </div>
        <div className="chat-actions">
          {!ended && <button className="btn btn-ghost btn-sm" onClick={() => setReporting(true)} disabled={reported}>Report</button>}
          {!ended && <button className="btn btn-ghost btn-sm" onClick={block}>Block</button>}
          {!ended && <button className="btn btn-danger btn-sm" onClick={chat.end}>End</button>}
        </div>
      </header>
      {!ended && <RevealPanel session={session} />}
      <div className="messages" ref={listRef} aria-live="polite">
        <p className="system-line">
          You are <strong>{session.alias}</strong>. Say hi to {session.partnerAlias}. Be kind; you're both anonymous.
        </p>
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.mine ? 'mine' : 'theirs'} ${m.deleted ? 'deleted' : ''}`}>
            {m.deleted ? 'Removed by a moderator' : m.body}
          </div>
        ))}
        {chat.partnerTyping && !ended && <div className="bubble theirs typing" aria-label="typing"><span /><span /><span /></div>}
        {session.revealed && <p className="system-line">You both revealed. Say hello properly!</p>}
        {ended && <p className="system-line">{endText}</p>}
      </div>
      {ended ? (
        <div className="chat-ended">
          <button className="btn btn-primary" onClick={chat.reset}>Find someone new</button>
          {session.revealed && !blocked && (
            <button className="btn btn-ghost" onClick={addFriend} disabled={friendSent}>{friendSent ? 'Request sent' : 'Add friend'}</button>
          )}
          {!reported && <button className="btn btn-ghost" onClick={() => setReporting(true)}>Report</button>}
          {!blocked && chat.ended?.reason !== 'blocked' && <button className="btn btn-ghost" onClick={block}>Block</button>}
        </div>
      ) : (
        <form className="composer" onSubmit={submit}>
          <input
            value={text}
            onChange={onType}
            maxLength={1000}
            placeholder={session.revealed ? 'Message' : 'Message (text and emoji only)'}
            aria-label="Message"
            autoFocus
          />
          <button className="btn btn-primary" disabled={!text.trim()}>Send</button>
        </form>
      )}
      {reporting && (
        <ReportDialog
          sessionId={session.id}
          alias={session.revealed ? session.partner.displayName : session.partnerAlias}
          onClose={() => setReporting(false)}
          onDone={({ blocked: b }) => {
            setReported(true);
            if (b) setBlocked(true);
            toast('Thanks. A moderator will review it.');
          }}
        />
      )}
      {chat.justRevealed && session.partner && <Revealed session={session} onClose={() => chat.setJustRevealed(false)} />}
    </div>
  );
}

export default function Connect() {
  const { phase, session } = useChat();
  if (phase === 'waiting') return <Waiting />;
  if ((phase === 'chatting' || phase === 'ended') && session) return <ChatRoom />;
  return <Setup />;
}
