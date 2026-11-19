const geocodeCache = new Map();
let lastGeocodeAt = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function geocodeTheatre(theatre) {
  const key = `${theatre.mall}, ${theatre.locality}, ${theatre.city}, India`;
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  // Photon is a free OpenStreetMap-based geocoder. Cache results and keep requests spaced.
  const wait = Math.max(0, 1100 - (Date.now() - lastGeocodeAt));
  if (wait) await sleep(wait);
  const url = new URL('https://photon.komoot.io/api/');
  url.searchParams.set('q', key);
  url.searchParams.set('limit', '1');
  lastGeocodeAt = Date.now();
  const response = await fetch(url, { headers: { 'User-Agent': 'MovieMate-Demo/1.0' }, signal: AbortSignal.timeout(7000) });
  if (!response.ok) throw new Error(`Location lookup unavailable (${response.status}).`);
  const data = await response.json();
  const coords = data.features?.[0]?.geometry?.coordinates;
  const point = Array.isArray(coords) ? { lon: Number(coords[0]), lat: Number(coords[1]) } : null;
  geocodeCache.set(key, point);
  return point;
}

export function haversineKm(a, b) {
  const rad = d => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(x));
}

export async function findNearbyCinemas({ location, radiusKm = 30 } = {}) {
  const lat = Number(location?.lat), lon = Number(location?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return { supported: false, message: 'Share your device location or tell me your city/locality so I can find nearby demo cinemas.' };
  }
  const raw = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../data/cinema.json', import.meta.url), 'utf8'));
  const results = [];
  const failures = [];
  for (const theatre of raw.theatres) {
    try {
      const point = await geocodeTheatre(theatre);
      if (!point) continue;
      const distanceKm = haversineKm({ lat, lon }, point);
      if (distanceKm <= Math.min(100, Math.max(1, Number(radiusKm) || 30))) {
        results.push({ city: theatre.city, mall: theatre.mall, theatre: theatre.name, locality: theatre.locality, distanceKm: Number(distanceKm.toFixed(1)), distanceBasis: 'geocoded venue locality/mall' });
      }
    } catch (error) { failures.push(error.message); }
  }
  results.sort((a, b) => a.distanceKm - b.distanceKm);
  return { supported: true, nearby: results, count: results.length, radiusKm: Math.min(100, Math.max(1, Number(radiusKm) || 30)), note: 'Distances are approximate straight-line distances to geocoded mall/locality results, not road distances. Geocoding uses OpenStreetMap data via the public Photon service; results are subject to its fair-use availability.', warning: failures.length ? 'Some theatre locations could not be geocoded; results may be incomplete.' : null };
}
