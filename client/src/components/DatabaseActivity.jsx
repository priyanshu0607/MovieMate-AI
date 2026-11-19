import { useEffect, useState } from 'react';
import { Activity, HardDrive, Radio, RefreshCw } from 'lucide-react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

function timeAgo(value) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return new Date(value).toLocaleTimeString();
}

function labelFor(event) {
  const details = event.details || {};
  if (event.event_type === 'tool') return details.toolName || event.action;
  if (event.event_type === 'watchlist') return details.title || event.action;
  if (event.event_type === 'message') return `${details.role || 'chat'} message`;
  if (event.event_type === 'agent') return event.action;
  return event.action;
}

export default function DatabaseActivity() {
  const [items, setItems] = useState([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    fetch(`${API}/activity?limit=25`)
      .then(response => {
        if (!response.ok) throw new Error('Could not load local activity');
        return response.json();
      })
      .then(rows => { if (active) setItems(rows); })
      .catch(err => { if (active) setError(err.message); });

    const stream = new EventSource(`${API}/activity/stream`);
    stream.onopen = () => { if (active) { setConnected(true); setError(''); } };
    stream.onmessage = message => {
      try {
        const payload = JSON.parse(message.data);
        if (payload.type === 'activity' && payload.event) {
          setItems(previous => [payload.event, ...previous.filter(item => item.id !== payload.event.id)].slice(0, 25));
        }
      } catch { /* Ignore malformed stream events. */ }
    };
    stream.onerror = () => { if (active) setConnected(false); };
    return () => { active = false; stream.close(); };
  }, []);

  return <section className="db-activity-panel">
    <div className="db-activity-heading">
      <div className="db-activity-title"><HardDrive size={15}/><strong>Local file activity</strong></div>
      <span className={`db-live-state ${connected ? 'connected' : ''}`}><Radio size={11}/>{connected ? 'LIVE' : 'RECONNECTING'}</span>
    </div>
    <p className="db-activity-subtitle">Saved in server/data/moviemate.json · updates as the app runs</p>
    {error && <div className="db-activity-error">{error}</div>}
    {!items.length && !error ? <div className="db-activity-empty"><RefreshCw size={14}/> Waiting for local events…</div> :
      <div className="db-activity-list">
        {items.map(item => <div className="db-event" key={`${item.event_type}-${item.id}`}>
          <span className={`db-event-dot ${item.status === 'error' ? 'failed' : ''}`}/>
          <div className="db-event-copy">
            <strong>{labelFor(item)}</strong>
            <span>{item.action}</span>
            <small>{timeAgo(item.created_at)}</small>
          </div>
          <span className="db-event-kind">{item.event_type}</span>
        </div>)}
      </div>}
  </section>;
}
