import { getProviders } from '../services/tmdb.js';
export const streamingTool = {
  name: 'find_streaming_providers',
  description: 'Find streaming, rental and purchase providers for a movie in a country. Default region is India (IN).',
  parameters: { type: 'object', properties: { movieId: { type: 'integer' }, region: { type: 'string', description: 'Two-letter country code, e.g. IN, US, GB' } }, required: ['movieId'] },
  execute: getProviders
};
