import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs } from 'firebase/firestore';

const app = initializeApp({ apiKey: "AIzaSyBvL6M_2kPGt8XrcgpPHfL-bwU9BAH57Qk", projectId: "insulation-services-da91a", storageBucket: "insulation-services-da91a.firebasestorage.app", messagingSenderId: "761459419108", appId: "1:761459419108:web:25235ad8b067eddb96c9f1" });
const db = getFirestore(app);
const snap = await getDocs(collection(db, 'permits'));

let withCoords = 0, noCoords = 0, zeroCoords = 0;
const weekSamples = new Set();
const badSamples = [];

snap.docs.forEach(d => {
  const p = d.data();
  weekSamples.add(p.week);
  const hasLat = p.lat && p.lat !== 0 && !isNaN(p.lat);
  const hasLng = p.lng && p.lng !== 0 && !isNaN(p.lng);
  if (hasLat && hasLng) withCoords++;
  else if (p.lat === 0 || p.lng === 0) { zeroCoords++; badSamples.push(`${p.address} | lat:${p.lat} lng:${p.lng} week:${p.week}`); }
  else { noCoords++; badSamples.push(`${p.address} | lat:${p.lat} lng:${p.lng} week:${p.week}`); }
});

console.log(`Total: ${snap.docs.length}`);
console.log(`With coords: ${withCoords}`);
console.log(`Zero coords (lat:0/lng:0): ${zeroCoords}`);
console.log(`Missing coords: ${noCoords}`);
console.log(`\nAll week formats:`);
[...weekSamples].sort().forEach(w => console.log(' ', w));
console.log(`\nFirst 10 bad permits:`);
badSamples.slice(0,10).forEach(b => console.log(' ', b));
process.exit(0);
