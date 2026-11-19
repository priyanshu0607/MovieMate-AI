import { searchMovies } from '../services/tmdb.js';
export const movieSearchTool = {
  name: 'search_movies',
  description: 'Search TMDB for movies. Use this for ordinary movie discovery and recommendations. For multiple genres, pass comma-separated TMDB genre IDs (science fiction 878, thriller 53). Use releaseYearGte for after/since-year constraints, maxRuntime for a runtime cap, and minRating for quality filters.',
  parameters: {
    type: 'object', properties: {
      query: { type: 'string', description: 'Optional title or keyword search' },
      genre: { type: 'string', description: 'TMDB genre ID: action 28, adventure 12, animation 16, comedy 35, crime 80, documentary 99, drama 18, family 10751, fantasy 14, history 36, horror 27, music 10402, mystery 9648, romance 10749, science fiction 878, TV movie 10770, thriller 53, war 10752, western 37' },
      year: { type: 'integer', description: 'Exact release year' }, releaseYearGte: { type: 'integer', description: 'Earliest release year, inclusive' }, language: { type: 'string', description: 'ISO 639-1 language code, e.g. en, hi, kn' },
      minRating: { type: 'number', description: 'Minimum TMDB rating from 0 to 10' },
      maxRuntime: { type: 'integer', description: 'Maximum runtime in minutes' },
      sortBy: { type: 'string', description: 'TMDB sort, e.g. popularity.desc or vote_average.desc' },
      page: { type: 'integer', minimum: 1, maximum: 500, description: 'TMDB results page. Use a later page for additional suggestions without repeating already shown movies.' }
    }, required: []
  },
  execute: searchMovies
};
