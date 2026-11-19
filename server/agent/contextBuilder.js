const MOVIE_TOOLS = new Set([
  'search_movies', 'get_movie_details', 'find_streaming_providers', 'search_movie_trailer', 'find_recommendable_shows'
]);
const PRIVATE_OR_MUTATING_TOOLS = new Set([
  'get_watchlist', 'add_to_watchlist', 'remove_from_watchlist',
  'list_my_bookings', 'book_demo_seats', 'get_show_seats', 'search_cinema_shows'
]);

function cleanString(value, max = 220) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : value;
}

function compactMovie(movie) {
  return {
    id: movie.id,
    title: cleanString(movie.title, 90),
    year: movie.year || movie.releaseDate?.slice?.(0, 4) || null,
    rating: movie.rating ?? null,
    genres: Array.isArray(movie.genres) ? movie.genres.slice(0, 5) : undefined,
    overview: cleanString(movie.overview, 180)
  };
}

function compactValue(value, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return cleanString(value, 180);
  if (depth > 2) return undefined;
  if (Array.isArray(value)) return value.slice(0, 6).map(item => compactValue(item, depth + 1));
  if (typeof value === 'object') {
    const allowed = ['id', 'title', 'name', 'year', 'rating', 'vote_average', 'overview', 'releaseDate', 'runtime', 'genres', 'director', 'cast', 'region', 'available', 'message', 'link', 'flatrate', 'rent', 'buy', 'trailer', 'url', 'channel'];
    const output = {};
    for (const key of allowed) {
      if (Object.hasOwn(value, key) && value[key] !== undefined) {
        output[key] = key === 'overview' ? cleanString(value[key], 180) : compactValue(value[key], depth + 1);
      }
    }
    return output;
  }
  return undefined;
}

export function compactToolResult(result) {
  if (Array.isArray(result)) return result.slice(0, 8).map(compactMovie);
  if (result && typeof result === 'object' && Array.isArray(result.shows)) {
    return {
      city: result.city, requestedLocality: result.requestedLocality, localityFallbackToCity: result.localityFallbackToCity,
      date: result.date, requestedTime: result.requestedTime, window: result.window,
      movies: (result.movies || []).slice(0, 10).map(m => ({ title: m.showTitle, tmdbTitle: m.tmdbTitle, year: m.year, rating: m.rating, voteCount: m.voteCount, genres: m.genres, overview: cleanString(m.overview, 160) })),
      shows: result.shows.map(s => ({ movieTitle: s.movieTitle, theatre: s.theatre, mall: s.mall, locality: s.locality, time: s.time, date: s.date, showId: s.showId, format: s.format, language: s.language }))
    };
  }
  if (result && typeof result === 'object') {
    if (Array.isArray(result.results)) return result.results.slice(0, 8).map(compactMovie);
    return compactValue(result);
  }
  return compactValue(result);
}

export function makeGroqEvidence(toolResults) {
  return (toolResults || [])
    .filter(item => MOVIE_TOOLS.has(item.tool) && !PRIVATE_OR_MUTATING_TOOLS.has(item.tool))
    .slice(-6)
    .map(item => ({ tool: item.tool, summary: compactToolResult(item.result) }));
}

export function shouldUseGroq(userMessage, toolResults) {
  const text = String(userMessage || '').toLowerCase();

  const cinemaIntent = /\b(show|shows|showtime|showtimes|screening|cinema|theatre|theater|seat|seats|ticket|tickets|book|booking|booked|availability|my bookings)\b/.test(text);
  const recommendationIntent = /\b(recommend|recommendation|suggest|movie|film|which should|help me choose|best)\b/.test(text);
  const hasShowtimeCandidateSet = (toolResults || []).some(item => item.tool === 'find_recommendable_shows' && item.result?.shows?.length);

  // Preserve Groq's recommendation role for showtime-first theatre discovery:
  // Groq ranks only the verified screened candidates, never inventing showtimes.
  if (cinemaIntent && !(hasShowtimeCandidateSet && recommendationIntent)) return false;
  if (/\bwatchlist\b/.test(text) && !hasShowtimeCandidateSet) return false;

  const complexLanguage = /\b(recommend|recommendation|similar|compare|comparison|best|rank|versus|vs\.?|based on|my taste|my preferences|shortlist|which should|help me choose|curate|mood|suggest)\b/.test(text);
  const movieEvidenceCount = (toolResults || []).filter(item => MOVIE_TOOLS.has(item.tool)).length;
  return complexLanguage && movieEvidenceCount > 0;
}

export function compactHistory(messages, maxMessages = 6, maxChars = 1800) {
  return (messages || []).slice(-maxMessages).map(message => {
    const bounded = {
      role: message.role,
      content: String(message.content || '').slice(0, maxChars)
    };
    // Preserve Ollama's tool-call handoff fields; dropping these breaks the agent loop.
    if (message.tool_calls) bounded.tool_calls = message.tool_calls;
    if (message.tool_name) bounded.tool_name = message.tool_name;
    if (message.tool_call_id) bounded.tool_call_id = message.tool_call_id;
    return bounded;
  });
}
