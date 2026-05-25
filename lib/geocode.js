// Geocodes permit addresses using Mapbox Geocoding API
// Results cached in localStorage — only geocodes new addresses

const CACHE_KEY = 'ist-geocode-cache-v2';

function getCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveCache(cache) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {}
}

async function geocodeOne(address, city, token) {
  const query = encodeURIComponent(`${address}, ${city}, Oklahoma`);
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${query}.json?access_token=${token}&country=US&limit=1&types=address,place`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.features?.length > 0) {
      const [lng, lat] = data.features[0].center;
      return { lat, lng };
    }
    return null;
  } catch { return null; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function geocodePermits(permits, token) {
  const cache = getCache();
  const results = {};
  const needsGeocode = [];

  // Check cache first
  for (const p of permits) {
    const key = `${p.address}|${p.city}`;
    if (cache[key]) {
      results[p.id] = cache[key];
    } else if (!p.address.includes('Multiple') && !p.address.includes('(') && !p.address.includes('subdivision')) {
      needsGeocode.push(p);
    }
  }

  // Geocode uncached addresses — 80ms between requests (Mapbox allows ~10/sec)
  for (const p of needsGeocode) {
    const coords = await geocodeOne(p.address, p.city, token);
    if (coords) {
      const key = `${p.address}|${p.city}`;
      cache[key] = coords;
      results[p.id] = coords;
    }
    await sleep(80);
  }

  saveCache(cache);
  return results;
}

export function applyGeocodedCoords(permits, geocodedMap) {
  return permits.map(p => geocodedMap[p.id] ? { ...p, ...geocodedMap[p.id] } : p);
}

export function clearGeocodeCache() {
  try { localStorage.removeItem(CACHE_KEY); } catch {}
}
