import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs } from 'firebase/firestore';
const app = initializeApp({ apiKey: "AIzaSyBvL6M_2kPGt8XrcgpPHfL-bwU9BAH57Qk", projectId: "insulation-services-da91a" });
const db = getFirestore(app);
const snap = await getDocs(collection(db, 'fbLeads'));
console.log(`Total docs: ${snap.docs.length}`);
snap.docs.slice(0, 3).forEach(d => console.log(JSON.stringify(d.data(), null, 2)));
process.exit(0);
