import { useEffect, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { useChat } from '../chat.jsx';
import Logo from './Logo.jsx';

function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('unveil-theme') || 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('unveil-theme', theme);
    } catch {
      // Storage unavailable; the choice just won't persist.
    }
  }, [theme]);
  return [theme, setTheme];
}

function ThemeIcon({ theme }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', 'aria-hidden': true };
  if (theme === 'dark') return <svg {...common}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>;
  if (theme === 'light') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }
  return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" /></svg>;
}

export default function Layout({ children }) {
  const { me, logout } = useAuth();
  const chat = useChat();
  const navigate = useNavigate();
  const [theme, setTheme] = useTheme();
  const nextTheme = { system: 'dark', dark: 'light', light: 'system' }[theme];

  const onLogout = async () => {
    await logout();
    navigate('/');
  };

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Unveil home">
          <Logo /> <span>unveil</span>
        </Link>
        <nav className="nav">
          {me?.role === 'student' && (
            <>
              <NavLink to="/connect">
                Connect{chat.phase === 'chatting' && <span className="live-dot" aria-label="chat in progress" />}
              </NavLink>
              <NavLink to="/history">History</NavLink>
              <NavLink to="/friends">Friends</NavLink>
              <NavLink to="/profile">Profile</NavLink>
            </>
          )}
          {me?.role === 'admin' && <NavLink to="/admin">Dashboard</NavLink>}
        </nav>
        <div className="topbar-actions">
          <button
            className="icon-btn"
            onClick={() => setTheme(nextTheme)}
            title={`Theme: ${theme}. Switch to ${nextTheme}.`}
            aria-label={`Theme: ${theme}. Switch to ${nextTheme}.`}
          >
            <ThemeIcon theme={theme} />
          </button>
          {me ? (
            <button className="btn btn-ghost btn-sm" onClick={onLogout}>Log out</button>
          ) : (
            me === null && <Link className="btn btn-ghost btn-sm" to="/login">Log in</Link>
          )}
        </div>
      </header>
      <main className="main">{children}</main>
    </div>
  );
}
