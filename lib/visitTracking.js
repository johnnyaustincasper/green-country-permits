import { db } from './firebase';
import {
  collection,
  addDoc,
  query,
  where,
  orderBy,
  getDocs,
  Timestamp,
  deleteDoc,
  doc,
} from 'firebase/firestore';

const VISITS_COLLECTION = 'permitVisits';

export async function logVisit(salesman, permitId, builderName, visitDate, notes) {
  try {
    const docRef = await addDoc(collection(db, VISITS_COLLECTION), {
      salesman,
      permitId: String(permitId),
      builderName,
      visitDate: Timestamp.fromDate(new Date(visitDate)),
      notes: notes || '',
      createdAt: Timestamp.now(),
    });
    return docRef.id;
  } catch (error) {
    console.error('Error logging visit:', error);
    throw error;
  }
}

export async function getVisitsForPermit(permitId) {
  try {
    const q = query(
      collection(db, VISITS_COLLECTION),
      where('permitId', '==', String(permitId)),
      orderBy('visitDate', 'desc')
    );
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      visitDate: doc.data().visitDate.toDate(),
      createdAt: doc.data().createdAt.toDate(),
    }));
  } catch (error) {
    console.error('Error fetching visits:', error);
    return [];
  }
}

export async function getVisitsForSalesman(salesman) {
  try {
    const q = query(
      collection(db, VISITS_COLLECTION),
      where('salesman', '==', salesman),
      orderBy('visitDate', 'desc')
    );
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      visitDate: doc.data().visitDate.toDate(),
      createdAt: doc.data().createdAt.toDate(),
    }));
  } catch (error) {
    console.error('Error fetching visits:', error);
    return [];
  }
}

export async function deleteVisit(visitId) {
  try {
    await deleteDoc(doc(db, VISITS_COLLECTION, visitId));
  } catch (error) {
    console.error('Error deleting visit:', error);
    throw error;
  }
}
