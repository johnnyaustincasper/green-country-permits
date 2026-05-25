// Geocodes all permits in Firestore that have lat=0 or missing lat/lng
import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, updateDoc } from 'firebase/firestore';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(__dirname, 'geocode-cache.json');
const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

if (!TOKEN) { console.error('Set NEXT_PUBLIC_MAPBOX_TOKEN'); process.exit(1); }

const app = getApps().length ? getApps()[0] : initializeApp({
  apiKey: "AIzaSyBvL6M_2kPGt8XrcgpPHfL-bwU9BAH57Qk",
  projectId: "insulation-services-da91a",
  storageBucket: "insulation-services-da91a.firebasestorage.app",
  messagingSenderId: "761459419108",
  appId: "1:761459419108:web:25235ad8b067eddb96c9f1",
});
const db = getFirestore(app);

let cache = {};
if (existsSync(CACHE_PATH)) { try { cache = JSON.parse(readFileSync(CACHE_PATH,'utf8')); } catch {} }

async function geocode(address, city) {
  const key = `${address}, ${city}, OK`;
  if (cache[key]) return cache[key];
  await new Promise(r => setTimeout(r, 120));
  const q = encodeURIComponent(key);
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${q}.json?access_token=${TOKEN}&country=US&limit=1&types=address,place`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.features?.length) {
      const [lng, lat] = data.features[0].center;
      cache[key] = { lat, lng };
      writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
      return { lat, lng };
    }
  } catch(e) { console.warn('  geocode error:', e.message); }
  return null;
}

const snap = await getDocs(collection(db, 'permits'));
const needsGeo = snap.docs.filter(d => {
  const data = d.data();
  return !data.lat || data.lat === 0 || !data.lng || data.lng === 0;
});

console.log(`Found ${needsGeo.length} permits missing coordinates (${snap.docs.length} total)`);

let done = 0, failed = 0;
for (const d of needsGeo) {
  const p = d.data();
  const coords = await geocode(p.address || '', p.city || 'Tulsa');
  if (coords) {
    await updateDoc(doc(db, 'permits', d.id), { lat: coords.lat, lng: coords.lng });
    console.log(`  ✓ [${++done}/${needsGeo.length}] ${p.address}, ${p.city} → ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`);
  } else {
    console.log(`  ✗ No coords: ${p.address}, ${p.city}`);
    failed++;
  }
}

console.log(`\nDone. Geocoded: ${done} | Failed: ${failed}`);
process.exit(0);
