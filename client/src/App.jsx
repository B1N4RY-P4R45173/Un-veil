import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import Layout from './components/Layout.jsx';
import Landing from './pages/Landing.jsx';
import Register from './pages/Register.jsx';
import Verify from './pages/Verify.jsx';
import Login from './pages/Login.jsx';
import Profile from './pages/Profile.jsx';
import Connect from './pages/Connect.jsx';
import History from './pages/History.jsx';
import Friends from './pages/Friends.jsx';
import Admin from './pages/Admin.jsx';
import Reset from './pages/Reset.jsx';
import { Terms, Privacy } from './pages/Legal.jsx';

function Guard({ role, children }) {
  const { me } = useAuth();
  const location = useLocation();
  if (me === undefined) return <div className="page-loading">Loading…</div>;
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (role && me.role !== role) return <Navigate to={me.role === 'admin' ? '/admin' : '/connect'} replace />;
  if (me.role === 'student' && !me.profileComplete && location.pathname !== '/profile') {
    return <Navigate to="/profile" replace state={{ onboarding: true }} />;
  }
  return children;
}

function Home() {
  const { me } = useAuth();
  if (me === undefined) return <div className="page-loading">Loading…</div>;
  if (me) return <Navigate to={me.role === 'admin' ? '/admin' : '/connect'} replace />;
  return <Landing />;
}

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/register" element={<Register />} />
        <Route path="/verify" element={<Verify />} />
        <Route path="/login" element={<Login />} />
        <Route path="/reset" element={<Reset />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/profile" element={<Guard role="student"><Profile /></Guard>} />
        <Route path="/connect" element={<Guard role="student"><Connect /></Guard>} />
        <Route path="/history" element={<Guard role="student"><History /></Guard>} />
        <Route path="/friends" element={<Guard role="student"><Friends /></Guard>} />
        <Route path="/admin/*" element={<Guard role="admin"><Admin /></Guard>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
