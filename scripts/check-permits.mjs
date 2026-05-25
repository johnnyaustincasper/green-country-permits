import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs } from 'firebase/firestore';

const app = initializeApp({ apiKey: "AIzaSyBvL6M_2kPGt8XrcgpPHfL-bwU9BAH57Qk", projectId: "insulation-services-da91a", storageBucket: "insulation-services-da91a.firebasestorage.app", messagingSenderId: "761459419108", appId: "1:761459419108:web:25235ad8b067eddb96c9f1" });
const db = getFirestore(app);
const snap = await getDocs(collection(db, 'permits'));
const withCoords = snap.docs.filter(d => { const p = d.data(); return p.lat && p.lat !== 0 && p.lng && p.lng !== 0; });
const weeks = [...new Set(snap.docs.map(d => d.data().week))].sort();
console.log('Total:', snap.docs.length);
console.log('With coords:', withCoords.length);
console.log('Without coords:', snap.docs.length - withCoords.length);
console.log('All unique weeks:', JSON.stringify(weeks, null, 2));
