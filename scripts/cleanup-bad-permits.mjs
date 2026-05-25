import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, deleteDoc, doc } from 'firebase/firestore';

const app = initializeApp({ apiKey: "AIzaSyBvL6M_2kPGt8XrcgpPHfL-bwU9BAH57Qk", projectId: "insulation-services-da91a", storageBucket: "insulation-services-da91a.firebasestorage.app", messagingSenderId: "761459419108", appId: "1:761459419108:web:25235ad8b067eddb96c9f1" });
const db = getFirestore(app);
const snap = await getDocs(collection(db, 'permits'));

// Delete permits with week='unknown' OR address longer than 60 chars (garbage from bad parse)
let deleted = 0;
for (const d of snap.docs) {
  const p = d.data();
  const isGarbage = p.week === 'unknown' || (p.address && p.address.length > 60) || (p.address && /Multi Jobs|Remarks|NEWHOUSES/i.test(p.address));
  if (isGarbage) {
    await deleteDoc(doc(db, 'permits', d.id));
    console.log(`Deleted: ${p.address?.substring(0,50)} | week:${p.week}`);
    deleted++;
  }
}
console.log(`\nDeleted ${deleted} bad permits. Remaining: ${snap.docs.length - deleted}`);
process.exit(0);
