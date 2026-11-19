import { Sparkles, RotateCcw } from 'lucide-react';
import MessageBubble from './MessageBubble';
import ChatInput from './ChatInput';
export default function ChatWindow({ messages, input, setInput, onSubmit, busy, onReset }) {
  return <section className="chat-panel">
    <div className="chat-heading"><div className="chat-title-icon"><Sparkles size={17}/></div><div><strong>Movie discovery</strong><span>Your personal AI cinema companion</span></div><button className="icon-button" title="Clear chat" onClick={onReset}><RotateCcw size={16}/></button></div>
    <div className="messages-area">
      {messages.length === 0 && <div className="welcome"><div className="welcome-orb"><Sparkles size={27}/></div><p className="eyebrow">YOUR AI MOVIE COMPANION</p><h2>What are we<br/><em>watching tonight?</em></h2><p>Tell me what you're in the mood for. I'll search, compare, find trailers and check streaming options.</p>
        <div className="suggestions"><button onClick={() => setInput('Find 3 highly rated sci-fi thrillers released after 2020, under 2 hours.')}> <span>✦</span> Find a sci-fi thriller</button><button onClick={() => setInput('Recommend a great mystery movie for tonight and find its trailer.')}> <span>◈</span> Mystery movie night</button><button onClick={() => setInput('Show me my saved watchlist.')}> <span>▤</span> View my watchlist</button></div>
      </div>}
      {messages.map((message, i) => <MessageBubble message={message} key={i}/>)}
      {busy && <div className="typing-indicator"><span></span><span></span><span></span><small>MovieMate is working</small></div>}
    </div>
    <ChatInput value={input} onChange={setInput} onSubmit={onSubmit} disabled={busy}/>
  </section>;
}
