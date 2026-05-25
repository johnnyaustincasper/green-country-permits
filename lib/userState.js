/**
 * userState.js
 * Firestore-backed user state for IST Permits.
 * Replaces localStorage for notes, statuses, route, visitLog, and dailyRoutes.
 *
 * Strategy: localStorage as synchronous cache + Firestore as source of truth.
 * Reads: return localStorage immediately, fire Firestore read in background.
 * Writes: write to localStorage optimistically, then write to Firestore.
 */

import { db } from './firebase';
import {
  doc,
  getDoc,
  setDoc,
  onSnapshot,
} from 'firebase/firestore';

// ─── Collection mapping ───────────────────────────────────────────────────────
const COLLECTIONS = {
  notes: 'permitNotes',
  statuses: 'permitStatuses',
  visitLog: 'visitLogs',
  route: 'routes',
  dailyRoutes: 'dailyRoutes',
};

// ─── localStorage keys ────────────────────────────────────────────────────────
const LS = {
  notes: (user) => `ist-permit-notes-${user}`,
  statuses: (user) => `ist-permit-status-${user}`,
  visitLog: (user) => `ist-visit-log-${user}`,
  route: (user) => `ist-route-list-${user}`,
  dailyRoutes: (user) => `ist-daily-routes-${user}`,
};

function lsGet(key, fallback) {
  if (typeof window === 'undefined') return fallback;
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
}

function lsSet(key, value) {
  if (typeof window !== 'undefined') {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }
}

// ─── Firestore helpers ────────────────────────────────────────────────────────
async function fsGet(collection, userId) {
  try {
    const snap = await getDoc(doc(db, collection, userId));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.warn(`[userState] fsGet ${collection}/${userId}:`, err.message);
    return null;
  }
}

async function fsSet(collection, userId, data) {
  try {
    await setDoc(doc(db, collection, userId), data, { merge: true });
  } catch (err) {
    console.warn(`[userState] fsSet ${collection}/${userId}:`, err.message);
  }
}

// ─── Subscribe to real-time updates ──────────────────────────────────────────
/**
 * Subscribe to all user state from Firestore.
 * Calls callbacks with fresh data when Firestore updates.
 * Returns unsubscribe function.
 */
export function subscribeUserState(userId, callbacks) {
  const unsubs = [];

  const subscribe = (colName, lsKey, onData) => {
    try {
      const ref = doc(db, colName, userId);
      const unsub = onSnapshot(ref, (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          onData(data);
        }
      }, (err) => {
        console.warn(`[userState] snapshot ${colName}/${userId}:`, err.message);
      });
      unsubs.push(unsub);
    } catch (err) {
      console.warn(`[userState] subscribe ${colName}:`, err.message);
    }
  };

  if (callbacks.onNotes) {
    subscribe(COLLECTIONS.notes, LS.notes(userId), (data) => {
      const notes = data.notes || {};
      lsSet(LS.notes(userId), notes);
      callbacks.onNotes(notes);
    });
  }

  if (callbacks.onStatuses) {
    subscribe(COLLECTIONS.statuses, LS.statuses(userId), (data) => {
      const statuses = data.statuses || {};
      lsSet(LS.statuses(userId), statuses);
      callbacks.onStatuses(statuses);
    });
  }

  if (callbacks.onRoute) {
    subscribe(COLLECTIONS.route, LS.route(userId), (data) => {
      const route = data.permits || [];
      lsSet(LS.route(userId), route);
      callbacks.onRoute(route);
    });
  }

  if (callbacks.onVisitLog) {
    subscribe(COLLECTIONS.visitLog, LS.visitLog(userId), (data) => {
      const log = data.entries || [];
      lsSet(LS.visitLog(userId), log);
      callbacks.onVisitLog(log);
    });
  }

  if (callbacks.onDailyRoutes) {
    subscribe(COLLECTIONS.dailyRoutes, LS.dailyRoutes(userId), (data) => {
      const routes = data.routes || {};
      lsSet(LS.dailyRoutes(userId), routes);
      callbacks.onDailyRoutes(routes);
    });
  }

  return () => unsubs.forEach(u => u());
}

// ─── Save functions ───────────────────────────────────────────────────────────

export async function saveNotes(userId, notes) {
  lsSet(LS.notes(userId), notes);
  await fsSet(COLLECTIONS.notes, userId, { notes, updatedAt: new Date().toISOString() });
}

export async function saveStatuses(userId, statuses) {
  lsSet(LS.statuses(userId), statuses);
  await fsSet(COLLECTIONS.statuses, userId, { statuses, updatedAt: new Date().toISOString() });
}

export async function saveRoute(userId, permits) {
  lsSet(LS.route(userId), permits);
  await fsSet(COLLECTIONS.route, userId, { permits, updatedAt: new Date().toISOString() });
}

export async function saveVisitLog(userId, entries) {
  lsSet(LS.visitLog(userId), entries);
  await fsSet(COLLECTIONS.visitLog, userId, { entries, updatedAt: new Date().toISOString() });
}

export async function saveDailyRoutes(userId, routes) {
  lsSet(LS.dailyRoutes(userId), routes);
  await fsSet(COLLECTIONS.dailyRoutes, userId, { routes, updatedAt: new Date().toISOString() });
}

// ─── Load functions (sync from localStorage) ──────────────────────────────────

export function loadNotes(userId) {
  return lsGet(LS.notes(userId), {});
}

export function loadStatuses(userId) {
  return lsGet(LS.statuses(userId), {});
}

export function loadRoute(userId) {
  return lsGet(LS.route(userId), []);
}

export function loadVisitLog(userId) {
  return lsGet(LS.visitLog(userId), []);
}

export function loadDailyRoutes(userId) {
  return lsGet(LS.dailyRoutes(userId), {});
}

export function loadSession() {
  return lsGet('ist-active-user', null);
}

export function saveSession(userId) {
  lsSet('ist-active-user', userId);
}

// ─── Visit log helper ─────────────────────────────────────────────────────────

export function buildVisitEntry(permit, statusKey) {
  return {
    permitId: String(permit.id),
    builder: permit.builder,
    address: permit.address,
    city: permit.city || '',
    status: statusKey,
    date: new Date().toISOString().slice(0, 10),
    ts: Date.now(),
  };
}
