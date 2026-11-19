export function isLikelyPendingCinemaReply(history, userMessage) {
  const lastAssistant = [...history].reverse().find(message => message.role === 'assistant');
  if (!lastAssistant) return false;
  const prompt = String(lastAssistant.content || '');
  const askedForCinemaDetail = /what time would you like to watch|share your device location|provide your city\/locality|enter your city\/locality|tell me your city\/locality/i.test(prompt);
  if (!askedForCinemaDetail) return false;
  const text = String(userMessage || '').trim();
  const shortReply = text.split(/\s+/).length <= 8;
  const looksLikeTime = /\b(?:at\s*)?\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b(?:morning|afternoon|evening|tonight)\b/i.test(text);
  const looksLikeLocation = /\b(?:in|at|near)\s+(?:bengaluru|bangalore|mumbai|bombay|delhi|gurugram|gurgaon|noida|hyderabad|secunderabad|chennai|madras|pune)\b/i.test(text) || /\b(?:my location|use my location|here)\b/i.test(text);
  return shortReply && (looksLikeTime || looksLikeLocation);
}

export const MOVIE_DISCOVERY_TOOL_NAMES = Object.freeze([
  'search_movies', 'get_movie_details', 'find_streaming_providers', 'search_movie_trailer',
  'get_watchlist', 'add_to_watchlist', 'remove_from_watchlist'
]);
export const CINEMA_TOOL_NAMES = Object.freeze([
  'find_nearby_cinemas', 'find_recommendable_shows', 'search_cinema_shows',
  'get_show_seats', 'list_my_bookings', 'book_demo_seats', 'cancel_demo_booking'
]);


/**
 * Extract explicit user goals before planning. This is a routing aid, not a
 * replacement for model reasoning: the planner still decides tool order for
 * combinations that need user choices or missing details.
 */
export function detectRequestIntents(message) {
  const text = String(message || '').toLowerCase().replace(/[’]/g, "'");
  const has = pattern => pattern.test(text);
  const genreMention = /\b(action|adventure|animation|animated|comedy|comedies|crime|documentary|drama|family|fantasy|history|historical|horror|music|musical|mystery|romance|romantic|science fiction|sci[ -]?fi|thriller|thrillers|war|western|superhero|super hero|hero|comic[ -]?book)\b/i.test(text);
  const movieNoun = /\b(movies?|films?)\b/i.test(text);
  const recommendationVerb = /\b(recommend|recommendation|suggest|suggestions|find|pick|choose|give|show|list|discover|get|want|need|looking for|looking to watch)\b/i.test(text);
  const movieRecommendation = recommendationVerb && (movieNoun || genreMention) &&
    !/\b(showtimes?|screenings?|cinema timings?|theatre timings?|theater timings?)\b/i.test(text) &&
    !/\b(available seats?|seat map|seat availability|book|booking|reserve|tickets?)\b/i.test(text);

  return {
    movieRecommendation,
    showtimes: has(/\b(showtimes?|screenings?|cinema timings?|theatre timings?)\b/) ||
      (has(/\b(find|show|get|look for)\b.{0,45}\bshow\b/) && has(/\b(near me|nearby|\d{1,2}(?::\d{2})?\s*(?:am|pm)|tonight|today|tomorrow)\b/)),
    seatAvailability: has(/\b(available seats?|seat availability|seat map|show me the seats?|which seats are free|free seats?)\b/),
    booking: has(/\b(book|booking|reserve|purchase)\b.{0,50}\b(movie|film|ticket|tickets|seat|seats)\b/) || has(/\b(get|buy)\s+(?:me\s+)?tickets?\b/),
    watchlistAdd: has(/\b(add|save|put)\b.{0,35}\b(watchlist|watch list)\b/),
    watchlistView: has(/\b(show|view|list|what(?:'s| is))\b.{0,30}\b(my )?watchlist\b/),
    trailer: has(/\b(trailer|teaser)\b/),
    streaming: has(/\b(stream|streaming|where can i watch|where to watch|ott)\b/),
    movieDetails: has(/\b(details|cast|runtime|director|plot|overview)\b/),
    ticketPrice: (has(/₹|\brs\.?\s*\d|\binr\s*\d|\b(ticket|seat)\s+(?:price|cost|rates?)\b|\bcheapest\b|\blowest price\b|\bbudget\b|\bprice range\b/i) || (has(/\b(under|below|less than|at most|above|over|more than|between)\s+₹?\s*\d{2,5}\b/i) && !has(/\b\d{1,2}\s*(hours?|hrs?|minutes?|mins?)\b/i))) && has(/\b(ticket|tickets|seat|seats|movie|movies|show|showtime|screening)\b/i),
    nearbyCinema: has(/\b(near me|nearby|closest)\b.{0,35}\b(cinema|theatre|theater|multiplex)\b/)
  };
}

const GENRE_PATTERNS = Object.freeze([
  [/\b(?:superhero|super hero|hero|comic[ -]?book)\b/, 28], [/\baction\b/, 28], [/\badventure\b/, 12], [/\b(?:animation|animated)\b/, 16],
  [/\bcomed(?:y|ies)\b/, 35], [/\bcrime\b/, 80], [/\bdocumentar(?:y|ies)\b/, 99],
  [/\bdrama\b/, 18], [/\bfamil(?:y|ies)\b/, 10751], [/\bfantasy\b/, 14],
  [/\bhistor(?:y|ical)\b/, 36], [/\bhorror\b/, 27], [/\b(?:music|musical)\b/, 10402],
  [/\bmystery\b/, 9648], [/\bromanc(?:e|tic)\b/, 10749],
  [/\b(?:science fiction|sci[ -]?fi)\b/, 878], [/\bthrillers?\b/, 53],
  [/\bwar\b/, 10752], [/\bwestern\b/, 37]
]);

export function extractTicketPriceFilter(message) {
  const text = String(message || '').toLowerCase().replace(/,/g, '');
  const explicitAmounts = [...text.matchAll(/(?:₹|rs\.?\s*|inr\s*)(\d{2,5})|\b(\d{2,5})\s*(?:rupees?|rs\.?|inr)\b/gi)].map(match => Number(match[1] || match[2]));
  const bareAmounts = [...text.matchAll(/\b(?:under|below|less than|at most|above|over|more than|between|from)\s+₹?\s*(\d{2,5})\b/gi)].map(match => Number(match[1]));
  const amounts = [...explicitAmounts, ...bareAmounts].filter(Number.isFinite);
  if (!amounts.length) return null;
  if (/\b(between|from)\b/.test(text) && amounts.length >= 2) {
    return { minPrice: Math.min(amounts[0], amounts[1]), maxPrice: Math.max(amounts[0], amounts[1]) };
  }
  if (/\b(above|over|more than|at least|minimum|min)\b/.test(text)) return { minPrice: amounts[0] };
  return { maxPrice: amounts[0] };
}

export function buildMovieRecommendationSearch(message) {
  const text = String(message || '').toLowerCase().replace(/[’]/g, "'");
  // Capture the requested count before later numeric constraints such as runtime/year.
  // Supports: "I want 3 comedy movies", "Find 3 highly rated sci-fi thrillers".
  const countMatch = text.match(/\b(?:i\s+)?(?:want|need|would like|recommend|suggest|find|give|show|list|get|pick)\s+(?:me\s+)?(\d{1,2})\b/) ||
    text.match(/\b(\d{1,2})\s+(?:(?:highly[- ]rated|good|best|top[- ]rated)\s+)?(?:[a-z-]+\s+){0,3}(?:movies?|films?|comed(?:y|ies)|thrillers?|horror|action|dramas?|romance|sci[ -]?fi)\b/);
  const asksForOne = /\b(?:a|an|one)\s+(?:good\s+|great\s+|funny\s+|popular\s+)?(?:superhero|super hero|hero|comic[ -]?book|comedy|horror|action|thriller|sci[ -]?fi)?\s*(?:movie|film)\b/.test(text);
  const count = asksForOne && !countMatch ? 1 : Math.min(10, Math.max(1, Number(countMatch?.[1] || 5)));
  const genres = [...new Set(GENRE_PATTERNS.filter(([pattern]) => pattern.test(text)).map(([, id]) => id))];
  const yearAfter = text.match(/\b(?:after|since|from)\s+(20\d{2})\b/);
  const yearExact = text.match(/\b(?:in|released in|from)\s+(20\d{2})\b/);
  const runtime = text.match(/\bunder\s+(\d+)\s*(hours?|hrs?|minutes?|mins?)\b/);
  const rating = text.match(/\b(?:rated|rating)\s+(?:above|over|at least)\s+(\d(?:\.\d)?)\b/);
  const args = { sortBy: /highly rated|top rated|best rated|highest rated/.test(text) ? 'vote_average.desc' : 'popularity.desc', page: 1 };
  if (genres.length) args.genre = genres.join(',');
  if (yearAfter) args.releaseYearGte = Number(yearAfter[1]) + 1;
  else if (yearExact) args.year = Number(yearExact[1]);
  if (runtime) args.maxRuntime = Number(runtime[1]) * (/hour|hr/.test(runtime[2]) ? 60 : 1) - 1;
  if (rating) args.minRating = Number(rating[1]);
  return { count, args };
}


/**
 * Extract cinema-specific movie preferences before showtime discovery.
 * A generic request ("a movie near me at 7 PM") returns no preference and
 * intentionally keeps the broad local-screening search.
 */
export function buildCinemaMoviePreference(message) {
  const text = String(message || '').trim();
  const recommendation = buildMovieRecommendationSearch(text);
  const genreIds = recommendation.args.genre
    ? recommendation.args.genre.split(',').filter(Boolean)
    : [];

  if (genreIds.length) {
    return {
      type: 'genre',
      genreIds,
      searchArgs: recommendation.args,
      count: recommendation.count,
      label: genreIds.map(id => ({
        '28': 'Action', '12': 'Adventure', '16': 'Animation', '35': 'Comedy',
        '80': 'Crime', '99': 'Documentary', '18': 'Drama', '10751': 'Family',
        '14': 'Fantasy', '36': 'History', '27': 'Horror', '10402': 'Music',
        '9648': 'Mystery', '10749': 'Romance', '878': 'Science Fiction',
        '53': 'Thriller', '10752': 'War', '37': 'Western'
      }[id] || id)).join(' + ')
    };
  }

  const patterns = [
    // Direct booking requests often name a title without a time/showtime clause.
    // Capture the title now so it survives the follow-up questions for time/location.
    /\b(?:book|reserve|get|buy)\s+(?:me\s+)?(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)?\s*(?:tickets?|seats?)?\s*(?:for|to\s+see)\s+["']?(.+?)["']?$/i,
    /\b(?:showtimes?|screenings?|shows?)\s+(?:for|of)\s+["']([^"']+)["']/i,
    /\b(?:find|show|get)\s+(?:me\s+)?["']?(.+?)["']?\s+showtimes?\b/i,
    /\b(?:find|show|get|watch|book)\s+(?:me\s+)?["']?(.+?)["']?\s+(?:playing|showing|screening)\b/i,
    /\b(?:find|show|get|watch|book)\s+(?:me\s+)?["']?(.+?)["']?\s+(?=(?:near\s+me|nearby|at\s+\d|around\s+\d|tonight|today|tomorrow|in\s+[a-z]))/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = match?.[1]?.trim().replace(/^the\s+movie\s+/i, '').replace(/^["']|["']$/g, '');
    if (!candidate) continue;
    if (/\b(movie|movies|film|films|show|shows|screening|screenings|theatre|theater|cinema)\b/i.test(candidate)) continue;
    if (/^(a|any|some|the)\s*$/i.test(candidate)) continue;
    return { type: 'title', title: candidate, label: candidate, count: recommendation.count };
  }
  return null;
}

/** A new, independently classified task must release any stale booking stage.
 * Genuine short replies are protected by their stage-specific intent.
 */
export function shouldPauseBookingForInterruption(stateStage, freshIntents = {}, stageIntent = null) {
  if (!['picking_show', 'awaiting_ticket_count', 'awaiting_seat_choice', 'awaiting_confirm'].includes(stateStage)) return false;
  // A complete new discovery request must win over a stale stage classifier.
  // For example, 'Find a movie near me after 8 PM' contains a clock time, but
  // it is not a selection from the previous list.
  if (['modify_ticket_count', 'modify_showtime', 'select_seats', 'confirm', 'decline'].includes(stageIntent?.intent)) return false;
  if (freshIntents.movieRecommendation || freshIntents.trailer || freshIntents.streaming || freshIntents.movieDetails || freshIntents.watchlistView || freshIntents.ticketPrice || freshIntents.showtimes) return true;
  if (stageIntent?.intent === 'select_show') return false;
  return false;
}

export function shouldClearPendingCinemaState(stateStage, freshIntents = {}, stageIntent = null) {
  if (!stateStage) return false;
  if (['select_show', 'select_movie', 'select_seats', 'confirm', 'decline', 'cancel_booking', 'confirm_cancel_booking', 'select_booking_to_cancel', 'skip_movie_choice', 'provide_time'].includes(stageIntent?.intent)) return false;
  return Boolean(
    freshIntents.movieRecommendation || freshIntents.trailer || freshIntents.streaming ||
    freshIntents.movieDetails || freshIntents.watchlistAdd || freshIntents.watchlistView ||
    freshIntents.showtimes || freshIntents.nearbyCinema || freshIntents.booking
  );
}

export function isSeatAvailabilityRequest(message) {
  return detectRequestIntents(message).seatAvailability;
}


export function isExplicitBookingConfirmation(message) {
  return /^(?:yes(?:[, ]+(?:confirm(?: booking)?|book))?|confirm(?: booking)?|proceed(?: with booking)?|book it|go ahead|confirm and book)[.! ]*$/i.test(String(message || '').trim());
}

export function assistantRequestedBookingConfirmation(history) {
  const lastAssistant = [...(history || [])].reverse().find(message => message.role === 'assistant');
  if (!lastAssistant) return false;
  const text = String(lastAssistant.content || '');
  const asksConfirmation = /(?:confirm|proceed).{0,60}(?:booking|reservation)|(?:shall|would) i book|reply yes.{0,40}book/i.test(text);
  const containsBookingSummary = /\bseat(?:s)?\b/i.test(text) && /\b(?:amount|total|price)\b/i.test(text) && /\b(?:movie|showtime|theatre|cinema)\b/i.test(text);
  return asksConfirmation && containsBookingSummary;
}
