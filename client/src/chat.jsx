// Holds the socket and the state of the current match/chat so it survives navigation.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from './auth.jsx';
import { useToast } from './toast.jsx';

const ChatContext = createContext(null);

const ack = (socket, event, payload) =>
  new Promise((resolve) => {
    if (!socket?.connected) return resolve({ ok: false, error: 'Not connected. Trying to reconnect…' });
    socket.timeout(8000).emit(event, payload, (err, res) => resolve(err ? { ok: false, error: 'The server did not respond.' } : res));
  });

export function ChatProvider({ children }) {
  const { me, setMe } = useAuth();
  const toast = useToast();
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [phase, setPhase] = useState('idle'); // idle | waiting | chatting | ended
  const [session, setSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [partnerTyping, setPartnerTyping] = useState(false);
  const [ended, setEnded] = useState(null);
  const [waitingSince, setWaitingSince] = useState(null);
  const [justRevealed, setJustRevealed] = useState(false);
  const sessionIdRef = useRef(null);

  const isStudent = me && me.role === 'student';

  useEffect(() => {
    if (!isStudent) return undefined;
    const socket = io({ withCredentials: true, transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    const startChat = (s, msgs = []) => {
      sessionIdRef.current = s.id;
      setSession(s);
      setMessages(msgs);
      setEnded(null);
      setPartnerTyping(false);
      setPhase('chatting');
    };

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', (err) => {
      setConnected(false);
      if (err.message === 'unauthorized') setMe(null);
    });
    socket.on('match:found', ({ session: s }) => {
      setWaitingSince(null);
      startChat(s);
    });
    socket.on('chat:resume', ({ session: s, messages: msgs }) => s && startChat(s, msgs));
    socket.on('chat:message', ({ sessionId, message }) => {
      if (sessionId !== sessionIdRef.current) return;
      setMessages((m) => (m.some((x) => x.id === message.id) ? m : [...m, message]));
      if (!message.mine) setPartnerTyping(false);
    });
    socket.on('chat:deleted', ({ id }) =>
      setMessages((m) => m.map((x) => (x.id === id ? { ...x, deleted: true, body: '' } : x))));
    socket.on('chat:typing', ({ sessionId, typing }) => sessionId === sessionIdRef.current && setPartnerTyping(typing));
    socket.on('reveal:status', ({ session: s }) => s.id === sessionIdRef.current && setSession(s));
    socket.on('reveal:done', ({ session: s }) => {
      if (s.id !== sessionIdRef.current) return;
      setSession(s);
      setJustRevealed(true);
    });
    socket.on('chat:ended', ({ sessionId, reason, byYou }) => {
      if (sessionId !== sessionIdRef.current) return;
      setPartnerTyping(false);
      setEnded({ reason, byYou });
      setSession((s) => (s ? { ...s, endedAt: new Date().toISOString(), endReason: reason } : s));
      setPhase('ended');
    });
    socket.on('chat:notice', ({ text, kind }) => toast(text, kind === 'moderation' ? 'warn' : 'info'));
    socket.on('account:warning', ({ text }) => toast(text, 'warn'));
    socket.on('friend:request', ({ from }) => toast(`${from} sent you a friend request.`));
    socket.on('friend:accepted', () => toast('Your friend request was accepted.'));
    socket.on('account:restricted', ({ status }) => {
      toast(status === 'banned' ? 'This account has been banned.' : 'Your account has been suspended pending review.', 'warn');
      setMe(null);
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      setPhase('idle');
      setSession(null);
      setMessages([]);
    };
  }, [isStudent, setMe, toast]);

  const findMatch = useCallback(async (mode, filter) => {
    const res = await ack(socketRef.current, 'queue:join', { mode, filter });
    if (res.ok && res.waiting) {
      setPhase('waiting');
      setWaitingSince(Date.now());
    }
    return res;
  }, []);

  const cancel = useCallback(async () => {
    await ack(socketRef.current, 'queue:leave', {});
    setPhase('idle');
    setWaitingSince(null);
  }, []);

  const send = useCallback((body) => ack(socketRef.current, 'chat:send', { sessionId: sessionIdRef.current, body }), []);
  const typing = useCallback((value) => {
    socketRef.current?.emit('chat:typing', { sessionId: sessionIdRef.current, typing: value });
  }, []);
  const reveal = useCallback(() => ack(socketRef.current, 'chat:reveal', { sessionId: sessionIdRef.current }), []);
  const end = useCallback(() => ack(socketRef.current, 'chat:end', { sessionId: sessionIdRef.current }), []);
  const reset = useCallback(() => {
    sessionIdRef.current = null;
    setSession(null);
    setMessages([]);
    setEnded(null);
    setJustRevealed(false);
    setPhase('idle');
  }, []);

  return (
    <ChatContext.Provider
      value={{
        connected, phase, session, messages, partnerTyping, ended, waitingSince, justRevealed,
        setJustRevealed, findMatch, cancel, send, typing, reveal, end, reset,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export const useChat = () => useContext(ChatContext);
