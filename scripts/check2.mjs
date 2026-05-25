import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs } from 'firebase/firestore';
const app = initializeApp({ apiKey: "AIzaSyBvL6M_2kPGt8XrcgpPHfL-bwU9BAH57Qk", projectId: "insulation-services-da91a", storageBucket: "insulation-services-da91a.firebasestorage.app", messagingSenderId: "761459419108", appId: "1:761459419108:web:25235ad8b067eddb96c9f1" });
const db = getFirestore(app);
const snap = await getDocs(collection(db, 'permits'));
const unknown = snap.docs.filter(d => d.data().week === 'unknown');
console.log('Unknown week count:', unknown.length);
console.log('Sample unknown:', unknown.slice(0,3).map(d => ({id: d.id, ...d.data()})));
const noCoords = snap.docs.filter(d => { const p = d.data(); return !p.lat || p.lat === 0; });
console.log('No coords sample:', noCoords.slice(0,3).map(d => ({week: d.data().week, address: d.data().address})));
// Check if any permits have week containing "3-8" or "3/8" style for March
const march = snap.docs.filter(d => { const w = d.data().week || ''; return w.includes('3/8') || w.includes('3/15') || w.includes('3/22') || w.includes('3-8') || w.includes('3-15') || w.includes('3-22'); });
console.log('March 3/8+ permits:', march.length);
