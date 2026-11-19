import axios from 'axios';
export const trailerTool = {
  name: 'search_movie_trailer',
  description: 'Find a movie trailer on YouTube. Uses the YouTube Data API when configured; otherwise returns a direct YouTube search link. Do not claim a result is an official trailer unless the API result supports that.',
  parameters: { type: 'object', properties: { title: { type: 'string' }, year: { type: 'string' } }, required: ['title'] },
  async execute({ title, year }) {
    const query = `${title} ${year || ''} official trailer`.trim();
    const key = process.env.YOUTUBE_API_KEY;
    if (!key) return { configured: false, searchUrl: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, note: 'YouTube API key is not configured; this is a YouTube search link, not a verified trailer.' };
    const { data } = await axios.get('https://www.googleapis.com/youtube/v3/search', { params: { part: 'snippet', q: query, type: 'video', maxResults: 5, key }, timeout: 12000 });
    return data.items.map(item => ({ title: item.snippet.title, channel: item.snippet.channelTitle, url: `https://www.youtube.com/watch?v=${item.id.videoId}` }));
  }
};
