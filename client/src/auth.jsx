import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [me, setMe] = useState(undefined); // undefined = loading, null = signed out
  const [meta, setMeta] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setMe(await api.get('/me'));
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    refresh();
    api.get('/meta').then(setMeta).catch(() => {});
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      // Already signed out on the server.
    }
    setMe(null);
  }, []);

  return <AuthContext.Provider value={{ me, setMe, meta, refresh, logout }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
