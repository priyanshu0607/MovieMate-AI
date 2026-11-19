import { movieSearchTool } from '../tools/movieSearch.js';
import { movieDetailsTool } from '../tools/movieDetails.js';
import { streamingTool } from '../tools/streamingProviders.js';
import { trailerTool } from '../tools/trailerSearch.js';
import { addWatchlistTool, listWatchlistTool, removeWatchlistTool } from '../tools/watchlist.js';
import { cinemaSearchTool } from '../tools/cinemaSearch.js';
import { cinemaSeatsTool } from '../tools/cinemaSeats.js';
import { myBookingsTool, bookSeatsTool, cancelBookingTool } from '../tools/cinemaBookings.js';
import { recommendShowsTool } from '../tools/recommendShows.js';
import { nearbyCinemasTool } from '../tools/nearbyCinemas.js';
import { MOVIE_DISCOVERY_TOOL_NAMES, CINEMA_TOOL_NAMES } from './workflowPolicy.js';

export const toolRegistry = [nearbyCinemasTool, movieSearchTool, movieDetailsTool, streamingTool, trailerTool, recommendShowsTool, addWatchlistTool, listWatchlistTool, removeWatchlistTool, cinemaSearchTool, cinemaSeatsTool, myBookingsTool, bookSeatsTool, cancelBookingTool];
export function toolsForIntent(intent = 'movie') {
  const allowed = intent === 'cinema'
    ? new Set([...MOVIE_DISCOVERY_TOOL_NAMES, ...CINEMA_TOOL_NAMES])
    : new Set(MOVIE_DISCOVERY_TOOL_NAMES);
  return toolRegistry.filter(tool => allowed.has(tool.name)).map(({ name, description, parameters }) => ({
    type: 'function', function: { name, description, parameters }
  }));
}

export const ollamaTools = toolRegistry.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } }));
export async function executeTool(name, args, context = {}) {
  if (context.allowedTools && !context.allowedTools.has(name)) {
    throw new Error(`Tool ${name} is not available for the current ${context.intent || 'movie'} workflow.`);
  }
  const tool = toolRegistry.find(t => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.execute(name === 'find_nearby_cinemas' ? { ...(args || {}), location: context.location } : (args || {}));
}
