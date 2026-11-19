import axios from 'axios';

const client = axios.create({
  baseURL: 'https://api.themoviedb.org/3',
  timeout: 25000
});

const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN',
  'ENOTFOUND', 'ERR_NETWORK'
]);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function requireKey() {
  if (!process.env.TMDB_API_KEY?.trim()) {
    throw new Error('TMDB_API_KEY is missing. Add your TMDB API key to server/.env.');
  }
}

// Retry transient network errors and temporary TMDB/server failures.
// Do not retry authentication, invalid-parameter, or other 4xx errors.
async function tmdbGet(url, config = {}, attempt = 0) {
  try {
    return await client.get(url, {
      ...config,
      params: {
        ...config.params,
        api_key: process.env.TMDB_API_KEY?.trim()
      }
    });
  } catch (error) {
    const status = error.response?.status;
    const retryable = RETRYABLE_CODES.has(error.code) ||
      status === 429 || (status >= 500 && status <= 599);

    if (!retryable || attempt >= 2) {
      if (error.code === 'ECONNRESET') {
        error.message = 'TMDB connection was reset. Check your internet/VPN connection and try again.';
      } else if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
        error.message = 'Could not resolve TMDB. Check your DNS or internet connection.';
      } else if (status === 429) {
        error.message = 'TMDB rate limit reached. Please wait a moment and try again.';
      }
      throw error;
    }

    const retryAfter = Number(error.response?.headers?.['retry-after']);
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 8000)
      : 700 * (2 ** attempt);
    await sleep(delay);
    return tmdbGet(url, config, attempt + 1);
  }
}

// Keep detail lookups bounded. A burst of 20 simultaneous requests can cause
// socket resets on slower networks and is unnecessary for a single search.
async function mapWithConcurrency(items, limit, mapper) {
  const output = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        output[index] = await mapper(items[index], index);
      }
    }
  );

  await Promise.all(workers);
  return output;
}

export const imageUrl = path => path ? `https://image.tmdb.org/t/p/w500${path}` : null;

export async function searchMovies({ query, genre, year, releaseYearGte, language, minRating, maxRuntime, sortBy = 'popularity.desc', page = 1 }) {
  requireKey();

  if (query) {
    const { data } = await tmdbGet('/search/movie', {
      params: { query, page, include_adult: false, year }
    });

    let results = (data.results || [])
      .map(normalizeMovie)
      .filter(m => !minRating || m.rating >= minRating);

    if (maxRuntime) {
      const candidates = results.slice(0, 20);
      const detailed = await mapWithConcurrency(candidates, 4, async movie => {
        try {
          const { data: details } = await tmdbGet(`/movie/${movie.id}`);
          return details.runtime && details.runtime <= maxRuntime ? movie : null;
        } catch (error) {
          // Preserve the search result if a detail lookup fails transiently;
          // never claim that its runtime was verified.
          console.warn(`[tmdb] Runtime lookup failed for movie ${movie.id}: ${error.message}`);
          return null;
        }
      });
      results = detailed.filter(Boolean);
    }

    return results;
  }

  const params = {
    page,
    sort_by: sortBy,
    include_adult: false,
    'vote_count.gte': 30
  };
  if (year) params.primary_release_year = year;
  if (releaseYearGte) params['primary_release_date.gte'] = `${releaseYearGte}-01-01`;
  if (genre) params.with_genres = genre;
  if (language) params.with_original_language = language;
  if (minRating) params['vote_average.gte'] = minRating;
  if (maxRuntime) params['with_runtime.lte'] = maxRuntime;

  const { data } = await tmdbGet('/discover/movie', { params });
  return (data.results || []).map(normalizeMovie);
}

export async function getMovieDetails({ movieId }) {
  requireKey();
  const { data } = await tmdbGet(`/movie/${movieId}`, {
    params: { append_to_response: 'credits,videos,watch/providers' }
  });

  const trailerKey = data.videos?.results?.find(
    v => v.site === 'YouTube' && v.type === 'Trailer'
  )?.key;

  return {
    ...normalizeMovie(data),
    runtime: data.runtime,
    genres: data.genres?.map(g => g.name) || [],
    tagline: data.tagline,
    cast: data.credits?.cast?.slice(0, 8).map(p => p.name) || [],
    director: data.credits?.crew?.find(p => p.job === 'Director')?.name || null,
    trailer: trailerKey ? `https://www.youtube.com/watch?v=${trailerKey}` : null,
    providers: data['watch/providers']?.results?.[process.env.TMDB_REGION || 'IN'] || null,
    homepage: data.homepage || null
  };
}

export async function getProviders({ movieId, region = process.env.TMDB_REGION || 'IN' }) {
  requireKey();
  const { data } = await tmdbGet(`/movie/${movieId}/watch/providers`);
  const result = data.results?.[region];

  if (!result) {
    return {
      region,
      available: false,
      message: 'No streaming provider information is currently listed for this region.'
    };
  }

  return {
    region,
    link: result.link,
    flatrate: result.flatrate || [],
    rent: result.rent || [],
    buy: result.buy || []
  };
}

function normalizeMovie(m) {
  return {
    id: m.id,
    title: m.title,
    overview: m.overview,
    releaseDate: m.release_date,
    year: m.release_date?.slice(0, 4) || null,
    rating: m.vote_average,
    voteCount: m.vote_count,
    poster: imageUrl(m.poster_path),
    backdrop: imageUrl(m.backdrop_path),
    genreIds: m.genre_ids || m.genres?.map(g => g.id) || [],
    language: m.original_language
  };
}
