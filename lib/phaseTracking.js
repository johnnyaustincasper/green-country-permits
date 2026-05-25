import { db } from './firebase';
import {
  collection,
  addDoc,
  query,
  where,
  orderBy,
  getDocs,
  updateDoc,
  doc,
  Timestamp,
  deleteDoc,
} from 'firebase/firestore';

const PHASES_COLLECTION = 'projectPhases';
const REMINDERS_COLLECTION = 'followUpReminders';

export const PHASES = [
  { id: 'design', label: 'Design Phase', color: '#6366f1', emoji: '📋' },
  { id: 'framing', label: 'Framing', color: '#f59e0b', emoji: '🔨' },
  { id: 'rough-in', label: 'Rough-In', color: '#ef4444', emoji: '🏗️' },
  { id: 'insulation', label: 'Insulation', color: '#3b82f6', emoji: '🧱' },
  { id: 'completed', label: 'Completed', color: '#10b981', emoji: '✓' },
];

export const INSULATION_TYPES = [
  'Fiberglass Batts',
  'Foam (Open Cell)',
  'Foam (Closed Cell)',
  'Spray Foam Mix',
  'Blown Fiberglass',
  'Rockwool',
  'Unknown',
];

export async function updateProjectPhase(permitId, salesman, phase, insulationType = null) {
  try {
    const q = query(
      collection(db, PHASES_COLLECTION),
      where('permitId', '==', String(permitId)),
      where('salesman', '==', salesman)
    );
    const existing = await getDocs(q);

    if (existing.docs.length > 0) {
      await updateDoc(doc(db, PHASES_COLLECTION, existing.docs[0].id), {
        phase,
        insulationType,
        updatedAt: Timestamp.now(),
      });
    } else {
      await addDoc(collection(db, PHASES_COLLECTION), {
        permitId: String(permitId),
        salesman,
        phase,
        insulationType,
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      });
    }
  } catch (error) {
    console.error('Error updating phase:', error);
    throw error;
  }
}

export async function getProjectPhase(permitId, salesman) {
  try {
    const q = query(
      collection(db, PHASES_COLLECTION),
      where('permitId', '==', String(permitId)),
      where('salesman', '==', salesman)
    );
    const snapshot = await getDocs(q);
    if (snapshot.docs.length > 0) {
      const doc = snapshot.docs[0];
      return {
        id: doc.id,
        ...doc.data(),
        updatedAt: doc.data().updatedAt?.toDate(),
        createdAt: doc.data().createdAt?.toDate(),
      };
    }
    return null;
  } catch (error) {
    console.error('Error fetching phase:', error);
    return null;
  }
}

export async function scheduleFollowUp(permitId, salesman, builderName, reminderDate, notes = '') {
  try {
    const docRef = await addDoc(collection(db, REMINDERS_COLLECTION), {
      permitId: String(permitId),
      salesman,
      builderName,
      reminderDate: Timestamp.fromDate(new Date(reminderDate)),
      notes,
      completed: false,
      createdAt: Timestamp.now(),
    });
    return docRef.id;
  } catch (error) {
    console.error('Error scheduling reminder:', error);
    throw error;
  }
}

export async function getFollowUpReminders(salesman) {
  try {
    const q = query(
      collection(db, REMINDERS_COLLECTION),
      where('salesman', '==', salesman),
      where('completed', '==', false),
      orderBy('reminderDate', 'asc')
    );
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      reminderDate: doc.data().reminderDate.toDate(),
      createdAt: doc.data().createdAt.toDate(),
    }));
  } catch (error) {
    console.error('Error fetching reminders:', error);
    return [];
  }
}

export async function completeReminder(reminderId) {
  try {
    await updateDoc(doc(db, REMINDERS_COLLECTION, reminderId), {
      completed: true,
      completedAt: Timestamp.now(),
    });
  } catch (error) {
    console.error('Error completing reminder:', error);
    throw error;
  }
}

export async function deleteReminder(reminderId) {
  try {
    await deleteDoc(doc(db, REMINDERS_COLLECTION, reminderId));
  } catch (error) {
    console.error('Error deleting reminder:', error);
    throw error;
  }
}
