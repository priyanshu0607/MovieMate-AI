import { Bookmark, Star, Trash2, Film } from 'lucide-react';
export default function Watchlist({ movies, onRemove }) {
  return <div className="watchlist-panel">
    <div className="panel-heading"><div><Bookmark size={17}/><strong>Your watchlist</strong></div><span>{movies.length} SAVED</span></div>
    {!movies.length ? <div className="watchlist-empty"><Film size={25}/><strong>No movies saved yet</strong><span>Ask MovieMate to save a movie you like.</span></div> : <div className="watchlist-items">{movies.map(movie => <div className="watchlist-movie" key={movie.movie_id}>
      {movie.poster ? <img src={movie.poster} alt=""/> : <div className="poster-placeholder"><Film/></div>}
      <div className="watchlist-info"><strong>{movie.title}</strong><span>{movie.year || 'Release year unknown'} {movie.rating ? `· ★ ${movie.rating.toFixed(1)}` : ''}</span></div>
      <button title="Remove from watchlist" onClick={() => onRemove(movie.movie_id)}><Trash2 size={15}/></button>
    </div>)}</div>}
  </div>;
}
