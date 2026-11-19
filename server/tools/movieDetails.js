import { getMovieDetails } from '../services/tmdb.js';
export const movieDetailsTool = {
  name: 'get_movie_details',
  description: 'Get detailed information about one movie by its TMDB movie ID, including runtime, cast, director, trailer and synopsis.',
  parameters: { type: 'object', properties: { movieId: { type: 'integer', description: 'TMDB movie ID' } }, required: ['movieId'] },
  execute: getMovieDetails
};
