export function normalizeMovieTitle(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

export function filterShowsByCandidateTitles(shows, candidateTitles) {
  if (!Array.isArray(candidateTitles) || candidateTitles.length === 0) return [];
  const wanted = new Set(candidateTitles.map(normalizeMovieTitle).filter(Boolean));
  return (shows || []).filter(show => wanted.has(normalizeMovieTitle(show.movieTitle)));
}

export function filterShowsByGenre(shows, genre) {
  const wanted = String(genre || '').trim().toLowerCase();
  if (!wanted) return [];
  return (shows || []).filter(show => String(show.genre || '').trim().toLowerCase() === wanted);
}
