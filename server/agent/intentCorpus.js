// intent-corpus.mjs
// MovieMate AI: intent catalogue, request corpus, and a classifier where NO message falls through.
// Layers: UI action -> stage-gated -> rules -> LLM (optional) -> keyword scoring -> "unknown" (clarify)
// Run tests: node intent-corpus.mjs --test

// ---------------------------------------------------------------- 1. INTENTS
export const INTENTS = [
  "movie_recommendation", // recs only, TMDB only, no cinema tools
  "movie_info",           // plot, cast, rating, trailer of ONE movie, no cinema tools
  "showtime_search",      // showtimes for a selected movie
  "direct_booking",       // book or watch something, starts from real screenings
  "select_movie",         // pick from shown recommendations
  "select_show",          // pick a theatre + time
  "select_seats",         // pick seats or seat category
  "confirm",              // yes, book it
  "decline",              // no, not that
  "cancel_booking",
  "modify_booking",
  "view_booking",
  "provide_city",         // answer to "which city?"
  "provide_time",         // answer to "what time?"
  "update_preferences",   // "I hate horror", "I prefer recliners"
  "greeting",
  "thanks_bye",
  "help",
  "out_of_scope",         // weather, jokes, code, etc.
  "unknown",              // ALWAYS handled: ask one clarifying question with chips
];

// ---------------------------------------------------------------- 2. HELPERS
const norm = s => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
const has = (s, re) => re.test(s);

export const CITIES = ["bengaluru", "bangalore", "mumbai", "delhi", "chennai", "hyderabad", "pune", "kolkata"];
export const AREAS = ["koramangala", "indiranagar", "whitefield", "jayanagar", "hsr", "mg road", "marathahalli", "malleshwaram", "yelahanka", "electronic city"];
const THEATRES = /\b(pvr|inox|cinepolis|miraj|gopalan|forum|orion|garuda|pvr inox)\b/;

const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b([01]?\d|2[0-3]):([0-5]\d)\b|\b(morning|afternoon|evening|night|tonight|noon|late|early|matinee|after (work|office))\b/;
const DATE_RE = /\b(today|tomorrow|tonight|day after|weekend|saturday|sunday|monday|tuesday|wednesday|thursday|friday|this week|next week)\b/;
const GENRE_RE = /\b(sci-?fi|science fiction|thriller|horror|comedy|romance|romcom|rom-com|action|drama|animation|animated|family|kids|fantasy|adventure|mystery|crime|documentary|biopic|war|musical|superhero|suspense|hindi|kannada|tamil|telugu|malayalam|english|korean|japanese|bollywood|hollywood)\b/;
const ORDINAL_RE = /\b(first|second|third|fourth|1st|2nd|3rd|4th|last|top|that|this|the (other|shorter|longer|good|best|highest rated|cheaper)) (one|movie|film|pick)\b|\b(first|second|third|1st|2nd|3rd) one\b|\boption [1-5]\b|\b#[1-5]\b/;

export function parseTime(s) {
  s = norm(s);
  const named = { morning: "10:00", noon: "12:00", afternoon: "14:00", evening: "19:00", tonight: "20:00", night: "21:30", matinee: "13:00" };
  const m = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (m && (m[3] || m[2])) {
    let h = +m[1]; const min = m[2] ?? "00";
    if (m[3] === "pm" && h < 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    if (h <= 23) return `${String(h).padStart(2, "0")}:${min}`;
  }
  for (const [k, v] of Object.entries(named)) if (s.includes(k)) return v;
  if (/^\d{1,2}$/.test(s) && +s >= 1 && +s <= 12) return `${String(+s < 9 ? +s + 12 : +s).padStart(2, "0")}:00`; // bare "7" => 19:00
  return null;
}
export const matchCity = s => {
  const c = CITIES.find(c => norm(s).includes(c));
  return c === "bangalore" ? "bengaluru" : c ?? null;
};

const NON_MOVIE = /\b(flights?|hotels?|trains?|bus|cab|uber|ola|table|restaurant|doctor|appointment|salon)\b/;
const FILLER = /^(yeah|yes|yep|yup|ok|okay|sure|please|hey|hi|so|well|actually|um|uh|hmm|alright|then)[,!. ]+/;

// ---------------------------------------------------------------- 3. LAYER 1: STAGE-GATED (short replies)
function byStage(s, session) {
  const st = session?.stage;
  if (!st) return null;

  const yes = /^(y|yes|yeah|yep|yup|sure|ok|okay|confirm|confirmed|go ahead|do it|book it|proceed|please do|sounds good|haan|ha|kar do|kar de|theek hai)\b/;
  const no = /^(n|no|nope|nah|not now|don't|do not|stop|wait|hold on|nahi|mat karo)\b/;

  if (st === "cancelling_booking") {
    if (/\b(cancel|confirm|yes|proceed)\b/.test(s)) return ["confirm_cancel_booking", 1];
    if (/\b(no|stop|keep|don't|do not)\b/.test(s)) return ["decline", 1];
    if (/\b(mm-[a-z0-9]{4,}|\d{1,2}|first|second|third|fourth)\b/.test(s)) return ["select_booking_to_cancel", 1];
  }
  if (st === "choosing_genre_movie") {
    if (/\b(showtimes?|skip|any movie|all movies|doesn't matter|doesnt matter)\b/.test(s)) return ["skip_movie_choice", 1];
    if (/\b(\d{1,2}|first|second|third|fourth|fifth|sixth)\b/.test(s)) return ["select_movie", 1];
  }
  if (st === "awaiting_genre_showtime") {
    if (parseTime(s)) return ["provide_time", 1];
  }
  if (["awaiting_ticket_count", "awaiting_seat_choice", "awaiting_confirm"].includes(st) && /\b(make it|change (?:it )?to|instead of|actually|update (?:the )?(?:ticket|seat) count)\b/.test(s) && /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b/.test(s)) return ["modify_ticket_count", 1];
  if (["awaiting_seat_choice", "awaiting_confirm"].includes(st) && /\b(change|switch|move)\b.{0,30}\b(show|showtime|time|screening)\b|\b(earlier|later)\s+(?:show|time)\b/.test(s)) return ["modify_showtime", 0.98];
  if (st === "awaiting_confirm") {
    if (yes.test(s)) return ["confirm", 1];
    if (no.test(s) || /\b(change|different|other|instead)\b/.test(s)) return ["decline", 1];
    if (/\b(cancel|never ?mind|forget it)\b/.test(s)) return ["cancel_booking", 1];
  }
  if (st === "awaiting_time") { if (parseTime(s) || /\b(any ?time|whenever|anytime|doesn't matter)\b/.test(s)) return ["provide_time", 1]; }
  if (st === "awaiting_city") { if (matchCity(s) || AREAS.some(a => s.includes(a))) return ["provide_city", 1]; }
  if (st === "picking_seats" && (/\b[a-z]\s?-?\d{1,2}\b/.test(s) || /\b(recliners?|picture perfect|standard|premium|middle|center|centre|back|front|together|aisle)\b/.test(s) || /^\d{1,2}\s*(seats?|tickets?)?$/.test(s) || /\b\d{1,2}\s*(seats?|tickets?)\b/.test(s) || /\bmake it \d/.test(s)))
    return ["select_seats", 1];
  if (st === "picking_show") {
    const shows = session.pendingShows ?? [];
    if (shows.some(show => norm(show.movieTitle || show.title || "") && s.includes(norm(show.movieTitle || show.title))))
      return ["select_show", 0.98];
    if (THEATRES.test(s) || TIME_RE.test(s) || ORDINAL_RE.test(s) || /\b(earliest|latest|cheapest|nearest|closest)\b/.test(s))
      return ["select_show", 0.9];
  }
  if (st === "awaiting_ticket_count" && (/^\d{1,2}$/.test(s) || /\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/.test(s) || /\b\d{1,2}\s*(tickets?|seats?)\b/.test(s)))
    return ["select_seats", 0.95];
  if (st === "awaiting_seat_choice" && (/\b(yes|these|recommended|suggested|those|middle|recliner|standard|picture perfect)\b/.test(s) || /\buse (the )?(suggested|recommended) seats\b/.test(s) || /\b[a-z]\s?-?\d{1,2}\b/.test(s)))
    return ["select_seats", 0.95];
  if (st === "recommending") {
    if (ORDINAL_RE.test(s)) return ["select_movie", 0.95];
    const titles = (session.lastRecommendations ?? []).map(m => norm(m.title));
    if (titles.some(t => s.includes(t))) return ["select_movie", 0.9];
  }
  return null;
}

// ---------------------------------------------------------------- 4. LAYER 2: RULES (ordered, specific first)
const RULES = [
  ["thanks_bye", s => /^(thanks?|thank you|thx|ty|cheers|bye|goodbye|see ya|cya|that's all|that is all|done|great thanks|dhanyavad|shukriya)\b/.test(s), 0.95],
  ["greeting", s => /^(hi+|hello+|hey+|yo|hola|namaste|namaskara|good (morning|afternoon|evening)|sup|what's up|wassup)( there| everyone| moviemate)?[\s!.?]*$/.test(s), 0.95],
  ["help", s => /\b(help|what can you do|how do(es)? (this|it) work|how to use|your features|commands|capabilities)\b/.test(s) && !/\bhelp me (book|find|pick|choose|watch|plan)\b/.test(s), 0.9],

  ["help", s => /\b(tell me about yourself|who are you|about you|your name|are you (a )?(bot|ai))\b/.test(s), 0.95],
  ["cancel_booking", s => /\brefund\b/.test(s), 0.9],
  ["cancel_booking", s => /\b(cancel|refund|undo)\b.*\b(booking|ticket|tickets|reservation|show|it|order)\b|\bcancel (my|the|this|that|it)\b|\bdon't want (the )?(booking|ticket)s?\b/.test(s), 0.95],
  ["modify_booking", s => /\b(change|modify|reschedule|move|shift|swap|edit|update)\b.*\b(booking|ticket|tickets|show|seat|seats|time|date|theatre|screening)\b/.test(s) && !/\bpreference/.test(s), 0.9],
  ["view_booking", s => (/\b(my|past|upcoming|recent|previous|last) (bookings?|tickets?|reservations?|orders?)\b|\bbooking (history|status|ref|reference|id|details)\b|\bwhat (did|have) i (book|booked)\b|\bmm-[a-z0-9]{4,}\b/.test(s)) && !/^(book|reserve|get|buy)\b/.test(s), 0.9],

  ["update_preferences", s => /\b(i (love|like|prefer|hate|dislike|can't stand|don't like|do not like|enjoy|am into)|my favou?rite|always (book|pick|choose)|never (book|show|pick)|remember that i|from now on)\b/.test(s) && !/\b(book|ticket|showtime|tonight|tomorrow)\b/.test(s) && !/\?$/.test(s), 0.8],

  // Booking: explicit verb wins
  ["direct_booking", s => /\b(book|reserve|buy|purchase|grab|secure|get me|get us|need|want|arrange)\b.*\b(tickets?|tkts?|seats?|movie|film|show|screening|something)\b/.test(s) || /^(book|reserve)\b/.test(s) || /\b(tickets?|tkts?) (book|kar|chahiye|do)\b|\bbook kar\b|\bbook (me|us|a|an|the|my|2|3|4|two|three|four|something|tickets)\b|\b(ticket|tkt)s? for\b/.test(s), 0.9],
  // Booking: watch + concrete time/date/city, or fully-open asks
  ["direct_booking", s => (/\b(watch|catch|see|go for|go to|head to|dekhna|dekhne)\b.*\b(movie|film|something|show|cinema|theatre|theater)?\b/.test(s) && (TIME_RE.test(s) || DATE_RE.test(s)) && !/\b(recommend|suggest|best|top|rated)\b/.test(s)), 0.75],
  ["direct_booking", s => /^(surprise me|just pick( for me)?|pick for me|you choose|you pick|plan my (evening|night|weekend|day)|do something fun for me|movie\??|cinema\??|date night|movie night|outing)\b/.test(s) || /\b(date night|movie night|family outing|birthday outing|plan (an?|my) (outing|evening|night))\b/.test(s) && !/\b(recommend|suggest)/.test(s), 0.9],
  ["direct_booking", s => /\b(movie|film|show|cinema) (tonight|today|tomorrow|this weekend)\b|\b(tonite|tonight)\??$/.test(s) && !/\b(recommend|suggest|best)\b/.test(s), 0.7],

  ["direct_booking", s => /\b(\d+|one|two|three|four|five|six|seven|eight) (tickets?|tkts?|seats?)\b/.test(s), 0.85],
  ["direct_booking", s => /\b(what|something|anything)\b.*\bwatch\b/.test(s) && (TIME_RE.test(s) || DATE_RE.test(s)) && !/\b(recommend|suggest|best|top|rated)\b/.test(s), 0.9],

  // Showtimes
  ["showtime_search", s => /\b(what's|whats|what is) (on|showing|playing|running)\b|\banything on\b|\b(how much|ticket price|ticket rates?|price of|cost of)\b/.test(s), 0.85],
  ["showtime_search", s => /\b(later|earlier|another|different|next) (show|time|slot|screening|timing)\b|\bsame movie\b/.test(s), 0.85],
  ["showtime_search", s => /\b(show ?times?|showings?|screenings?|show timings?|timings?|schedule|playing|running|now showing|in theatres?|in cinemas?|which theatres?|where can i (watch|see)|where is .* (playing|showing)|what time is|what time does|nearby theatres?|theatres? near|cinemas? near)\b/.test(s), 0.9],
  ["showtime_search", s => /\bnear (me|us|here)\b|\bnearby\b|\bclose to me\b/.test(s) && /\b(watch|movie|film|theatre|cinema|dune|show)\b/.test(s), 0.7],

  // Info about a movie (never touches the cinema)
  ["movie_info", s => /\b(plot|story|synopsis|cast|actors?|director|directed|trailer|runtime|how long is|rating of|imdb|reviews?|worth (watching|it|seeing)|is .* (any )?good|what is .* about|tell me about|who (is|was|plays|stars)|who's in|release date|when (did|was|does) .* (release|come out)|sequel|spoiler|ending|explain)\b/.test(s) && !/\b(recommend|suggest|similar|like)\b.*\b(movies?|films?)\b/.test(s) && !/\bbook\b/.test(s), 0.8],

  // Recommendations
  ["movie_recommendation", s => /\b(recommend\w*|suggest\w*|ideas?|options?|top \d+|best|highly rated|top rated|popular|trending|underrated|hidden gems?|similar to|something like|movies? like|films? like|what (should|can|do) i watch|what to watch|anything good|good (movies?|films?)|(new|latest|recent) (releases?|movies?|films?)|binge|watchlist|what's good|whats good)\b/.test(s), 0.85],
  ["movie_recommendation", s => GENRE_RE.test(s) && /\b(movies?|films?|something|anything|stuff|picks?|one|suggestions?)\b/.test(s), 0.75],
  ["movie_recommendation", s => /\b(bored|entertain me|cheer me up|in the mood for|feel like (watching|a)|want to (cry|laugh)|nothing heavy|mind-?blowing|edge of my seat|light ?hearted|feel[- ]good|something fun|something funny|something scary)\b/.test(s), 0.7],
  ["movie_recommendation", s => /\b(anything but|no (hindi|horror|tamil|telugu|kannada|english)|nothing too (long|scary|heavy|violent|sad))\b/.test(s), 0.6],

  // Out of scope
  ["out_of_scope", s => /\b(weather|temperature|stock|crypto|bitcoin|recipe|joke|poem|song lyrics|code|python|javascript|homework|translate|capital of|news|cricket score|football score|flight|hotel|train|uber|ola|swiggy|zomato|restaurant|food order|pizza|math|solve|calculate|horoscope|prime minister|president)\b/.test(s) && !/\b(movie|film|ticket|show|cinema|theatre)\b/.test(s), 0.95],
];

// ---------------------------------------------------------------- 5. LAYER 4: KEYWORD SCORING (last non-LLM net)
const KEYWORDS = {
  movie_recommendation: ["movie", "film", "watch", "genre", "recommend", "suggest", "good", "best", "like", "similar", "thriller", "comedy", "romance", "action"],
  showtime_search: ["time", "timing", "show", "where", "theatre", "cinema", "near", "playing", "screen"],
  direct_booking: ["book", "ticket", "seat", "reserve", "tonight", "tomorrow", "pm", "am", "evening"],
  movie_info: ["plot", "cast", "actor", "director", "review", "rating", "trailer", "about"],
  view_booking: ["booking", "ticket", "history", "reference"],
  help: ["help", "how", "what", "can"],
};
function keywordScore(s) {
  let best = ["unknown", 0];
  for (const [intent, words] of Object.entries(KEYWORDS)) {
    const hits = words.filter(w => s.includes(w)).length;
    const score = hits / Math.sqrt(words.length);
    if (score > best[1]) best = [intent, score];
  }
  return best[1] >= 0.6 ? best : ["unknown", 0];
}

// ---------------------------------------------------------------- 6. CLASSIFIER (never throws, never returns undefined)
export function classifyRules(message, session = {}) {
  const s = norm(String(message ?? ""));
  if (!s) return { intent: "unknown", confidence: 0, layer: "empty" };

  const st = byStage(s, session);
  if (st) return { intent: st[0], confidence: st[1], layer: "stage" };

  const run = str => RULES.filter(([intent, test]) => {
    if (intent === "direct_booking" && NON_MOVIE.test(str) && !/\b(movie|film|cinema|show|ticket)/.test(str)) return false;
    try { return test(str); } catch { return false; }
  });
  let matches = run(s);
  const stripped = s.replace(FILLER, "");
  if (!matches.length && stripped && stripped !== s) matches = run(stripped);
  if (matches.length) {
    const [intent, , confidence] = matches.sort((a, b) => b[2] - a[2])[0]; // highest confidence wins, rule order breaks ties
    return { intent, confidence, layer: "rules" };
  }
  const [intent, score] = keywordScore(s);
  if (intent !== "unknown") return { intent, confidence: Math.min(0.5, score / 2), layer: "keywords" };
  return { intent: "unknown", confidence: 0, layer: "none" };
}

/**
 * Full pipeline. `llmClassify(message, session)` is optional and must return an intent string.
 * Layer 3 (LLM) runs only when rules are unsure, so most turns cost 0 tokens.
 */
export async function classify(message, session = {}, { llmClassify, threshold = 0.7, timeoutMs = 3500 } = {}) {
  const r = classifyRules(message, session);
  if (r.confidence >= threshold || !llmClassify) return ensure(r);
  try {
    const out = await Promise.race([
      llmClassify(message, session),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
    ]);
    if (INTENTS.includes(out) && out !== "unknown") return { intent: out, confidence: 0.8, layer: "llm" };
  } catch { /* fall through to rule result */ }
  return ensure(r);
}
const ensure = r => (INTENTS.includes(r.intent) ? r : { intent: "unknown", confidence: 0, layer: "ensure" });

// What the agent does for "unknown" so nothing is dropped
export const CLARIFY = {
  text: "I can recommend movies, find showtimes, or book tickets. What would you like to do?",
  chips: ["Recommend movies", "Find showtimes", "Book tickets", "My bookings"],
};

// ---------------------------------------------------------------- 7. CORPUS: [message, expectedIntent, stage?]
const S = (stage, extra = {}) => ({ stage, ...extra });
const RECS = [{ title: "Dune" }, { title: "Arrival" }, { title: "Interstellar" }];

export const CORPUS = [
  // ---- movie_recommendation
  ["Recommend 3 highly rated sci-fi thrillers released after 2020, under 2 hours", "movie_recommendation"],
  ["Recommend some sci-fi movies", "movie_recommendation"],
  ["Suggest a good comedy", "movie_recommendation"],
  ["What should I watch?", "movie_recommendation"],
  ["Top 5 action movies of 2024", "movie_recommendation"],
  ["Best thriller films", "movie_recommendation"],
  ["Something like Inception", "movie_recommendation"],
  ["Movies like Interstellar", "movie_recommendation"],
  ["Any good horror movies?", "movie_recommendation"],
  ["Underrated gems from the last 5 years", "movie_recommendation"],
  ["Trending movies right now", "movie_recommendation"],
  ["I'm bored, entertain me", "movie_recommendation"],
  ["Something to cheer me up", "movie_recommendation"],
  ["I want to cry at the movies", "movie_recommendation"],
  ["Something that'll keep me on the edge of my seat", "movie_recommendation"],
  ["Nothing heavy, my brain is fried", "movie_recommendation"],
  ["Anything but horror", "movie_recommendation"],
  ["Nothing too long", "movie_recommendation"],
  ["Feel-good movies for the weekend", "movie_recommendation"],
  ["Animated movies for kids", "movie_recommendation"],
  ["romcom suggestions", "movie_recommendation"],
  ["Latest releases?", "movie_recommendation"],
  ["Good Kannada movies", "movie_recommendation"],
  ["new films worth my time, suggest few", "movie_recommendation"],
  ["Mind-blowing movies", "movie_recommendation"],
  ["something scary", "movie_recommendation"],
  ["Hidden gems in thriller", "movie_recommendation"],
  ["Give me top rated war movies", "movie_recommendation"],

  // ---- movie_info
  ["Is Dune worth watching?", "movie_info"],
  ["What's the plot of Arrival?", "movie_info"],
  ["Who plays the lead in Oppenheimer?", "movie_info"],
  ["Tell me about Interstellar", "movie_info"],
  ["Cast of Jawan", "movie_info"],
  ["How long is Avengers Endgame?", "movie_info"],
  ["Trailer for Dune Part Two", "movie_info"],
  ["What is Tenet about?", "movie_info"],
  ["IMDB rating of Inception", "movie_info"],
  ["Who directed Parasite?", "movie_info"],
  ["Explain the ending of Inception", "movie_info"],
  ["Is Barbie any good?", "movie_info"],
  ["release date of Avatar 3", "movie_info"],

  // ---- showtime_search
  ["Find showtimes for Dune near me", "showtime_search"],
  ["What time is Dune playing?", "showtime_search"],
  ["Where can I watch Arrival?", "showtime_search"],
  ["Showtimes for Jawan in Bengaluru", "showtime_search"],
  ["Is Interstellar running in theatres?", "showtime_search"],
  ["Which theatres are showing Oppenheimer?", "showtime_search"],
  ["Screenings of Dune tonight", "showtime_search"],
  ["Theatres near me", "showtime_search"],
  ["Now showing in Koramangala", "showtime_search"],
  ["Dune show timings", "showtime_search"],
  ["same movie but a later show", "showtime_search", S("showtimes")],
  ["What's playing at PVR Forum?", "showtime_search"],

  // ---- direct_booking
  ["Book a movie for me in Bengaluru at 7 PM", "direct_booking"],
  ["Book 2 tickets for Dune at PVR Forum tomorrow 7pm", "direct_booking"],
  ["Get me tickets for Interstellar", "direct_booking"],
  ["I want to watch something tonight", "direct_booking"],
  ["I'm free Saturday evening, what should I watch?", "direct_booking"],
  ["Book me something fun", "direct_booking"],
  ["Surprise me with a movie tonight", "direct_booking"],
  ["Book the highest rated movie playing near me after 8pm", "direct_booking"],
  ["Cheapest ticket for a movie under 2 hours today", "direct_booking"],
  ["Book 4 seats together for Avengers, recliners if possible", "direct_booking"],
  ["Two tickets, somewhere in the middle", "direct_booking"],
  ["bhai ek ticket book kar de Dune ka aaj raat", "direct_booking"],
  ["book 2 tkts for jawan 9pm", "direct_booking"],
  ["movie tonite?", "direct_booking"],
  ["Book a movie", "direct_booking"],
  ["Plan my evening", "direct_booking"],
  ["Do something fun for me", "direct_booking"],
  ["Just pick for me", "direct_booking"],
  ["Surprise me", "direct_booking"],
  ["Movie?", "direct_booking"],
  ["Date night, any ideas?", "direct_booking"],
  ["Taking my parents out this weekend, book something", "direct_booking"],
  ["Birthday outing with 6 friends", "direct_booking"],
  ["Reserve seats for tomorrow evening", "direct_booking"],
  ["I need tickets for tonight", "direct_booking"],
  ["Buy 3 tickets for Oppenheimer", "direct_booking"],
  ["Book it for 9 PM at Cinepolis", "direct_booking"],
  ["Yeah, book Dune", "direct_booking"],
  ["Get us seats for a movie at 6pm", "direct_booking"],
  ["Sometime after work I'd like to catch a movie", "direct_booking"],
  ["Grab me a ticket for the 8 pm show", "direct_booking"],
  ["I want to go for a movie tomorrow evening", "direct_booking"],

  // ---- select_movie (after recommendations)
  ["Book the second one", "select_movie", S("recommending", { lastRecommendations: RECS })],
  ["the first one", "select_movie", S("recommending", { lastRecommendations: RECS })],
  ["Dune", "select_movie", S("recommending", { lastRecommendations: RECS })],
  ["that one", "select_movie", S("recommending", { lastRecommendations: RECS })],
  ["the shorter one", "select_movie", S("recommending", { lastRecommendations: RECS })],
  ["option 3", "select_movie", S("recommending", { lastRecommendations: RECS })],
  ["The good one", "select_movie", S("recommending", { lastRecommendations: RECS })],

  // ---- select_show
  ["book Heart of the beast", "select_show", S("picking_show", { pendingShows: [{ movieTitle: "Heart of the Beast" }] })],
  ["Heart of the Beast", "select_show", S("picking_show", { pendingShows: [{ movieTitle: "Heart of the Beast" }] })],
  ["Heart of the Beast at 7 pm", "select_show", S("picking_show", { pendingShows: [{ movieTitle: "Heart of the Beast" }] })],
  ["Choose the 6:45 PM one", "select_show", S("picking_show")],
  ["PVR INOX", "select_show", S("picking_show")],
  ["the earliest", "select_show", S("picking_show")],
  ["first one", "select_show", S("picking_show")],
  ["Cinepolis at 7:15", "select_show", S("picking_show")],
  ["the cheapest show", "select_show", S("picking_show")],

  // ---- select_seats
  ["2 tickets", "select_seats", S("awaiting_ticket_count")],
  ["yes, use the recommended seats", "select_seats", S("awaiting_seat_choice")],
  ["A5, A6", "select_seats", S("picking_seats")],
  ["2 recliners please", "select_seats", S("picking_seats")],
  ["picture perfect", "select_seats", S("picking_seats")],
  ["somewhere in the middle", "select_seats", S("picking_seats")],
  ["4 together, aisle", "select_seats", S("picking_seats")],
  ["standard is fine", "select_seats", S("picking_seats")],
  ["3 seats", "select_seats", S("picking_seats")],
  ["Actually make it 3 tickets", "modify_ticket_count", S("awaiting_confirm")],
  ["Actually make it 3 seats", "select_seats", S("picking_seats")],

  // ---- confirm / decline
  ["yes", "confirm", S("awaiting_confirm")],
  ["Yes please confirm", "confirm", S("awaiting_confirm")],
  ["go ahead", "confirm", S("awaiting_confirm")],
  ["book it", "confirm", S("awaiting_confirm")],
  ["haan kar do", "confirm", S("awaiting_confirm")],
  ["sure", "confirm", S("awaiting_confirm")],
  ["no", "decline", S("awaiting_confirm")],
  ["no, change the seats", "decline", S("awaiting_confirm")],
  ["wait, pick a different show", "decline", S("awaiting_confirm")],
  ["nahi", "decline", S("awaiting_confirm")],

  // ---- provide_time / provide_city
  ["7", "provide_time", S("awaiting_time")],
  ["7pm", "provide_time", S("awaiting_time")],
  ["evening", "provide_time", S("awaiting_time")],
  ["19:30", "provide_time", S("awaiting_time")],
  ["any time", "provide_time", S("awaiting_time")],
  ["whenever", "provide_time", S("awaiting_time")],
  ["Bengaluru", "provide_city", S("awaiting_city")],
  ["bangalore", "provide_city", S("awaiting_city")],
  ["Koramangala", "provide_city", S("awaiting_city")],
  ["I'm in Indiranagar", "provide_city", S("awaiting_city")],
  ["Mumbai", "provide_city", S("awaiting_city")],

  // ---- cancel / modify / view booking
  ["Cancel my booking", "cancel_booking"],
  ["cancel the ticket", "cancel_booking"],
  ["I want a refund for my ticket", "cancel_booking"],
  ["cancel it", "cancel_booking"],
  ["never mind, cancel", "cancel_booking", S("awaiting_confirm")],
  ["Change my booking to 9 PM", "modify_booking"],
  ["Reschedule my show", "modify_booking"],
  ["Move my tickets to tomorrow", "modify_booking"],
  ["swap my seats", "modify_booking"],
  ["Show my bookings", "view_booking"],
  ["What did I book?", "view_booking"],
  ["my upcoming tickets", "view_booking"],
  ["booking status MM-AB12CD34", "view_booking"],
  ["booking history", "view_booking"],

  // ---- update_preferences
  ["I hate horror", "update_preferences"],
  ["I prefer recliners", "update_preferences"],
  ["I love Nolan films", "update_preferences"],
  ["From now on always pick middle seats", "update_preferences"],
  ["Never show me Hindi movies", "update_preferences"],
  ["my favourite genre is sci-fi", "update_preferences"],

  // ---- greeting / thanks / help / out_of_scope
  ["Hi", "greeting"],
  ["hello!", "greeting"],
  ["Hey there", "greeting"],
  ["good evening", "greeting"],
  ["namaste", "greeting"],
  ["Thanks!", "thanks_bye"],
  ["thank you so much", "thanks_bye"],
  ["bye", "thanks_bye"],
  ["that's all", "thanks_bye"],
  ["What can you do?", "help"],
  ["help", "help"],
  ["how does this work", "help"],
  ["What's the weather in Bengaluru?", "out_of_scope"],
  ["Tell me a joke", "out_of_scope"],
  ["Write python code to sort a list", "out_of_scope"],
  ["order me a pizza", "out_of_scope"],
  ["who is the prime minister of India", "out_of_scope"],
  ["Book a flight to Delhi", "out_of_scope"],

  // ---- added after held-out check
  ["what's good right now", "movie_recommendation"],
  ["is there anything on at 9?", "showtime_search"],
  ["show me what's on", "showtime_search"],
  ["how much for recliners", "showtime_search"],
  ["tell me about yourself", "help"],
  ["i want a refund", "cancel_booking"],
  ["recommend something light for date night", "movie_recommendation"],

  // ---- unknown (must be caught and clarified, never crash)
  ["asdfgh", "unknown"],
  ["???", "unknown"],
  ["hmm", "unknown"],
  ["ok so", "unknown"],
  ["", "unknown"],
  ["🙂", "unknown"],
];

// ---------------------------------------------------------------- 8. SELF-TEST
async function selfTest() {
  let pass = 0; const fails = [];
  for (const [msg, want, session = {}] of CORPUS) {
    const got = await classify(msg, session);
    if (got.intent === want) pass++; else fails.push({ msg, want, got: got.intent, layer: got.layer });
  }
  // Safety: garbage inputs must always return a valid intent
  const garbage = [null, undefined, 42, {}, [], "\u0000", "a".repeat(10000), "'; DROP TABLE movies;--", "<script>alert(1)</script>"];
  let safe = true;
  for (const g of garbage) { const r = await classify(g); if (!INTENTS.includes(r.intent)) safe = false; }

  const total = CORPUS.length;
  console.log(`Corpus: ${pass}/${total} correct (${((pass / total) * 100).toFixed(1)}%)`);
  console.log(`Garbage inputs always return a valid intent: ${safe ? "YES" : "NO"}`);
  if (fails.length) { console.log("\nMisclassified:"); for (const f of fails) console.log(` - "${f.msg}" want=${f.want} got=${f.got} [${f.layer}]`); }
  process.exitCode = fails.length || !safe ? 1 : 0;
}
if (process.argv.includes("--test")) await selfTest();
