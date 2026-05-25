import { initializeApp, getApps } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyBvL6M_2kPGt8XrcgpPHfL-bwU9BAH57Qk",
  authDomain: "insulation-services-da91a.firebaseapp.com",
  projectId: "insulation-services-da91a",
  storageBucket: "insulation-services-da91a.firebasestorage.app",
  messagingSenderId: "761459419108",
  appId: "1:761459419108:web:25235ad8b067eddb96c9f1",
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
export const db = getFirestore(app);
