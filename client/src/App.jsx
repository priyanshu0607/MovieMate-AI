import { useCallback, useEffect, useState } from 'react';
import { Clapperboard, CircleHelp, Github, Menu, Sparkles, Wifi, WifiOff, MapPin } from 'lucide-react';
import ChatWindow from './components/ChatWindow';
import AgentActivity from './components/AgentActivity';
import Watchlist from './components/Watchlist';
import DatabaseActivity from './components/DatabaseActivity';
import { getHealth, getWatchlist, getConversation, removeWatchlist, sendChat } from './services/api';
import './styles.css';

export default function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [events, setEvents] = useState([]);
  const [busy, setBusy] = useState(false);
  const [watchlist, setWatchlist] = useState([]);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState('');
  const [deviceLocation, setDeviceLocation] = useState(null);
  const [locationStatus, setLocationStatus] = useState('Location not shared');
  const [conversationId, setConversationId] = useState(() => {
    const key = 'moviemate-conversation-id';
    let id = window.localStorage.getItem(key);
    if (!id) {
      id = window.crypto.randomUUID();
      window.localStorage.setItem(key, id);
    }
    return id;
  });

  const refresh = useCallback(async () => {
    const [healthResult, watchlistResult] = await Promise.allSettled([getHealth(), getWatchlist()]);
    if (healthResult.status === 'fulfilled') setHealth(healthResult.value);
    else setHealth({ status: 'offline', ollama: { connected: false }, tmdbConfigured: false });
    if (watchlistResult.status === 'fulfilled') setWatchlist(watchlistResult.value);
  }, []);
  useEffect(() => {
    refresh();
    getConversation(conversationId).then(rows => setMessages(rows)).catch(err => setError(err.message));
  }, [refresh, conversationId]);

  // Reuse browser permission if the user has already granted location access.
  // If permission is still 'prompt', wait for an explicit click on Share location.
  useEffect(() => {
    if (!navigator.permissions?.query) return;
    navigator.permissions.query({ name: 'geolocation' })
      .then(permission => { if (permission.state === 'granted') shareLocation(); })
      .catch(() => {});
  }, []);

  function startNewConversation() {
    if (busy) return;
    const nextId = window.crypto.randomUUID();
    window.localStorage.setItem('moviemate-conversation-id', nextId);
    setConversationId(nextId);
    setMessages([]); setEvents([]); setError('');
  }

  function shareLocation() {
    if (!navigator.geolocation) { setLocationStatus('Geolocation is not supported by this browser'); return; }
    setLocationStatus('Requesting location permission…');
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => { setDeviceLocation({ lat: coords.latitude, lon: coords.longitude }); setLocationStatus('Location shared'); },
      error => { setDeviceLocation(null); setLocationStatus(error.code === 1 ? 'Permission denied — enter your city instead' : 'Location unavailable — enter your city instead'); },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }
    );
  }

  async function submit() {
    const text = input.trim();
    if (!text || busy) return;
    setInput(''); setError(''); setBusy(true); setEvents([]);
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    let finalAnswer = '';
    try {
      await sendChat(text, event => {
        if (event.type === 'complete') { finalAnswer = event.answer; setMessages(prev => [...prev, { role: 'assistant', content: event.answer }]); refresh(); }
        else if (event.type === 'error') setError(event.message);
        setEvents(prev => [...prev, event]);
      }, conversationId, deviceLocation);
      if (!finalAnswer && !error) setError('The agent finished without returning a final answer.');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); refresh(); }
  }

  async function removeMovie(id) {
    try { await removeWatchlist(id); setWatchlist(prev => prev.filter(m => m.movie_id !== id)); }
    catch (e) { setError(e.message); }
  }

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><div className="brand-mark"><Clapperboard size={20}/></div><span>movie<span className="brand-accent">mate</span></span><small>AI CINEMA</small></div>
      <div className="topbar-right"><button className="top-icon" title={locationStatus} onClick={shareLocation}><MapPin size={16}/> {deviceLocation ? 'LOCATION ON' : 'SHARE LOCATION'}</button><div className={`connection ${health?.ollama?.connected ? 'online' : 'offline'}`}><span className="status-dot"/>{health?.ollama?.connected ? 'OLLAMA CONNECTED' : 'OLLAMA OFFLINE'}</div><button className="top-icon" title="About MovieMate" onClick={() => alert('MovieMate is a locally running AI movie assistant. It uses Ollama for reasoning and tools for movie discovery and watchlist actions.')}><CircleHelp size={17}/></button></div>
    </header>
    <main className="main-layout"><aside className="left-rail"><div className="rail-label">WORKSPACE</div><div className="rail-item active"><Sparkles size={17}/> Movie assistant</div><div className="rail-label rail-spaced">YOUR LIBRARY</div><div className="rail-item"><Clapperboard size={17}/> Watchlist <span className="rail-count">{watchlist.length}</span></div><div className="rail-note"><div className="note-icon"><Sparkles size={15}/></div><strong>Powered by local AI</strong><p>Your conversations are processed using Ollama on your own machine.</p></div><div className="rail-footer"><span className="status-dot online-dot"/> LOCAL DEVELOPMENT</div></aside>
      <div className="center-column"><ChatWindow messages={messages} input={input} setInput={setInput} onSubmit={submit} busy={busy} onReset={startNewConversation}/>{error && <div className="error-banner">{error}</div>}</div>
      <aside className="right-column"><div className="right-heading"><div><span className="eyebrow">LIVE WORKFLOW</span><h3>Agent activity</h3></div><span className={`live-pill ${busy ? 'running' : ''}`}><span/> {busy ? 'RUNNING' : 'IDLE'}</span></div><AgentActivity events={events} busy={busy}/><Watchlist movies={watchlist} onRemove={removeMovie}/><DatabaseActivity/><div className="api-status"><div className="api-status-row"><span>Ollama model</span><strong>{health?.ollama?.model || 'Checking…'}</strong></div><div className="api-status-row"><span>Local JSON storage</span><strong className={health?.storage?.connected ? 'text-green' : 'text-warn'}>{health?.storage?.connected ? 'Ready' : 'Unavailable'}</strong></div><div className="api-status-row"><span>TMDB API</span><strong className={health?.tmdbConfigured ? 'text-green' : 'text-warn'}>{health?.tmdbConfigured ? 'Configured' : 'Needs API key'}</strong></div></div></aside>
    </main>
    <footer className="app-footer"><span>MovieMate · Built with React, Node.js & Ollama</span><span>Movie data provided by TMDB · Not endorsed or certified by TMDB</span></footer>
  </div>;
}
