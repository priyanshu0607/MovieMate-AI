import { Bot, User } from 'lucide-react';
export default function MessageBubble({ message }) {
  const user = message.role === 'user';
  return <div className={`message-row ${user ? 'user-row' : ''}`}>
    <div className={`avatar ${user ? 'user-avatar' : ''}`}>{user ? <User size={16}/> : <Bot size={17}/>}</div>
    <div className={`message ${user ? 'user-message' : 'assistant-message'}`}>
      <div className="message-label">{user ? 'YOU' : 'MOVIEMATE'}</div>
      <div className="message-content">{message.content}</div>
    </div>
  </div>;
}
