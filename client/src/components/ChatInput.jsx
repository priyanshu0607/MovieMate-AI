import { ArrowUp, Paperclip } from 'lucide-react';
export default function ChatInput({ value, onChange, onSubmit, disabled }) {
  return <form className="chat-input-wrap" onSubmit={e => { e.preventDefault(); onSubmit(); }}>
    <textarea value={value} onChange={e => onChange(e.target.value)} placeholder="Ask MovieMate to find your next movie…" rows={2} disabled={disabled} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(); } }}/>
    <div className="input-bottom"><span><Paperclip size={14}/> Enter to send · Shift + Enter for new line</span><button className="send-button" type="submit" disabled={disabled || !value.trim()}><ArrowUp size={18}/></button></div>
  </form>;
}
