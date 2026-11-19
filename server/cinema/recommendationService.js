import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchMovies } from '../services/tmdb.js';
import { normalizeMovieTitle, filterShowsByCandidateTitles, filterShowsByGenre } from './movieMatching.js';
import { timeToMinutes } from './timeUtils.js';
import { filterShowsByTicketPrice, filterSeatCategoriesByTicketPrice } from './ticketPrice.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataFile = path.resolve(here, '../data/cinema.json');


function withinWindow(showTime, requestedTime, windowHours) {
  const show = timeToMinutes(showTime);
  const target = timeToMinutes(requestedTime);
  // Cinema showtimes are on the same local calendar date; do not wrap across midnight.
  return Math.abs(show - target) <= windowHours * 60;
}

async function enrichMovieTitles(titles) {
  // Cinema schedules are the source of truth. TMDB enrichment is optional and
  // must never hold up showtime discovery. Enrich at most 3 distinct titles,
  // concurrently, with a short deadline; return the verified screenings even
  // when TMDB is slow or unavailable.
  const unique = [...new Set(titles)].slice(0, 3);
  const withDeadline = (promise, ms, title) => new Promise(resolve => {
    const timer = setTimeout(() => resolve({ showTitle: title, tmdbMatch: false, metadataNote: 'TMDB enrichment timed out; screening data is still valid.' }), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); resolve({ showTitle: title, tmdbMatch: false, metadataError: error.message }); });
  });
  return Promise.all(unique.map(async title => {
    try {
      return await withDeadline((async () => {
        const matches = await searchMovies({ query: title });
        const exact = matches.find(m => m.title?.toLowerCase() === title.toLowerCase());
        const movie = exact || matches[0];
        return movie ? {
          showTitle: title, tmdbId: movie.id, tmdbTitle: movie.title,
          year: movie.year, rating: movie.rating, voteCount: movie.voteCount,
          genres: movie.genreIds, overview: movie.overview, language: movie.language
        } : { showTitle: title, tmdbMatch: false };
      })(), 6500, title);
    } catch (error) {
      return { showTitle: title, tmdbMatch: false, metadataError: error.message };
    }
  }));
}

/**
 * Showtime discovery intersects the local schedule with TMDB candidates whenever
 * the user specifies a genre or title. Generic showtime searches remain broad.
 */

export async function findRecommendableShows({ city, locality, date, requestedTime, windowHours = 2, afterRequestedTime = false, preferredLanguage = null, excludeMovieTitles = [], includeMovieTitles = null, preference = null, minPrice = null, maxPrice = null } = {}) {
  if (!city || !date || !requestedTime) {
    throw new Error('city, date and requestedTime are required.');
  }
  const hours = Math.min(6, Math.max(0.5, Number(windowHours) || 2));
  timeToMinutes(requestedTime);
  const data = JSON.parse(await readFile(dataFile, 'utf8'));
  const cityRow = data.cities.find(c => c.name.toLowerCase() === String(city).trim().toLowerCase());
  if (!cityRow) {
    const localityMatch = data.cities.find(c => (c.localities || []).some(l => l.toLowerCase() === String(city).trim().toLowerCase()));
    if (!localityMatch) return { supported: false, message: 'This location does not exist in my memory yet.', supportedCities: data.cities.map(c => c.name), shows: [], movies: [] };
  }
  const resolvedCity = cityRow || data.cities.find(c => (c.localities || []).some(l => l.toLowerCase() === String(city).trim().toLowerCase()));
  const cityName = resolvedCity.name;
  const requestedLocality = String(locality || (!cityRow ? city : '')).trim();
  const cityTheatres = data.theatres.filter(t => t.city.toLowerCase() === cityName.toLowerCase());
  const localTheatres = requestedLocality
    ? cityTheatres.filter(t => String(t.locality || '').toLowerCase().includes(requestedLocality.toLowerCase()) || String(t.mall || '').toLowerCase().includes(requestedLocality.toLowerCase()))
    : cityTheatres;
  const localTheatreMap = new Map(localTheatres.map(t => [t.id, t]));
  const matchesRequestedTime = showTime => afterRequestedTime
    ? timeToMinutes(showTime) > timeToMinutes(requestedTime)
    : withinWindow(showTime, requestedTime, hours);
  const localShows = data.shows.filter(s => localTheatreMap.has(s.theatre_id) && s.date === date && matchesRequestedTime(s.time));
  // If the locality has no matching screenings (not merely no theatres), widen to the city.
  const isLocalityFallback = Boolean(requestedLocality && localShows.length === 0);
  const selectedTheatres = isLocalityFallback ? cityTheatres : localTheatres;
  const theatreMap = new Map(selectedTheatres.map(t => [t.id, t]));
  const eligibleShows = isLocalityFallback
    ? data.shows.filter(s => theatreMap.has(s.theatre_id) && s.date === date && matchesRequestedTime(s.time))
    : localShows;
  const excluded = new Set((Array.isArray(excludeMovieTitles) ? excludeMovieTitles : []).map(x => String(x).trim().toLowerCase()));
  let rawShows = eligibleShows.filter(s => !excluded.has(s.movie_title.toLowerCase()));
  // A show qualifies when at least one seat category is within the requested budget.
  rawShows = filterShowsByTicketPrice(rawShows, { minPrice, maxPrice });
  // When a genre/title preference was explicitly requested, never silently
  // fall back to unrelated screenings. Candidate titles must come from TMDB
  // discovery (or the explicit title lookup) before matching the local schedule.
  if (preference?.type === 'genre' && preference.label) {
    rawShows = filterShowsByGenre(rawShows, preference.label);
  } else if (preference?.type === 'title' && Array.isArray(includeMovieTitles)) {
    rawShows = filterShowsByCandidateTitles(
      rawShows.map(show => ({ ...show, movieTitle: show.movie_title })),
      includeMovieTitles
    );
  } else if (Array.isArray(includeMovieTitles)) {
    rawShows = filterShowsByCandidateTitles(
      rawShows.map(show => ({ ...show, movieTitle: show.movie_title })),
      includeMovieTitles
    );
  }
  const shows = rawShows.map(s => {
    const theatre = theatreMap.get(s.theatre_id);
    return {
      showId: s.id, movieTitle: s.movie_title, genre: s.genre || 'Drama', city: theatre.city, locality: theatre.locality,
      mall: theatre.mall, theatre: theatre.name, distanceKm: theatre.distance_km,
      auditorium: s.auditorium, date: s.date, time: s.time, language: s.language,
      format: s.format,
      seatCategories: filterSeatCategoriesByTicketPrice(Object.entries(s.seat_categories).map(([key, c]) => ({ key, label: c.label, price: c.price })), { minPrice, maxPrice })
    };
  }).sort((a, b) => {
    const languageRank = preferredLanguage
      ? Number(String(a.language || '').toLowerCase() !== String(preferredLanguage).toLowerCase()) - Number(String(b.language || '').toLowerCase() !== String(preferredLanguage).toLowerCase())
      : 0;
    return languageRank || (afterRequestedTime
      ? timeToMinutes(a.time) - timeToMinutes(b.time)
      : Math.abs(timeToMinutes(a.time) - timeToMinutes(requestedTime)) - Math.abs(timeToMinutes(b.time) - timeToMinutes(requestedTime)));
  });
  const movieTitles = [...new Set(shows.map(s => s.movieTitle))];
  const movies = await enrichMovieTitles(movieTitles);
  return {
    supported: true, city: cityName, requestedLocality: requestedLocality || null,
    localityFallbackToCity: isLocalityFallback,
    date, requestedTime, windowHours: hours, afterRequestedTime, preferredLanguage,
    window: afterRequestedTime ? { from: minutesToTime(Math.min(1439, timeToMinutes(requestedTime) + 1)), to: '23:59' } : { from: minutesToTime(Math.max(0, timeToMinutes(requestedTime) - hours * 60)), to: minutesToTime(Math.min(1439, timeToMinutes(requestedTime) + hours * 60)) },
    excludedMovieTitles: [...excluded], preference, minPrice, maxPrice, candidateMovieCount: Array.isArray(includeMovieTitles) ? includeMovieTitles.length : null,
    showCount: shows.length, shows, movies,
    note: 'These are seeded local demo-catalogue screenings, not live theatre listings.'
  };
}

function minutesToTime(total) {
  const safe = Math.max(0, Math.min(1439, Math.round(total)));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}
