import { findRecommendableShows } from '../cinema/recommendationService.js';

export const recommendShowsTool = {
  name: 'find_recommendable_shows',
  description: 'Search the local demo cinema schedule for screenings within +/- windowHours of requestedTime. If the user specified a genre or movie title, first discover/verify candidate titles with TMDB, then pass includeMovieTitles so only those matching screenings are returned. If no preference was specified, return all matching local screenings. Never silently fall back to unrelated titles when a preference filter has zero matches.',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'Parent supported city, e.g. Bengaluru. If the user gives only a known locality, use that locality as city and the tool resolves it.' },
      locality: { type: 'string', description: 'Optional locality such as Rajajinagar. Search there first, then fall back to citywide catalogue if there are no theatres in that locality.' },
      date: { type: 'string', description: 'Requested local show date in YYYY-MM-DD format.' },
      requestedTime: { type: 'string', description: 'Requested local time in 24-hour HH:MM format, e.g. 20:00.' },
      windowHours: { type: 'number', description: 'Hours either side of requestedTime; default 2.' },
      minPrice: { type: 'number', description: 'Minimum allowed per-ticket price in INR.' },
      maxPrice: { type: 'number', description: 'Maximum allowed per-ticket price in INR.' },
      excludeMovieTitles: { type: 'array', items: { type: 'string' }, description: 'Movies already suggested and rejected in this conversation. Exclude these when offering another option.' }
    },
    required: ['city', 'date', 'requestedTime']
  },
  execute: findRecommendableShows
};
