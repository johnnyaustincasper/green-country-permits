/**
 * migrate-permits.js
 * One-shot script to migrate all permits from lib/permits.js into Firestore.
 *
 * Uses Firebase Admin SDK if service account exists at:
 *   /Users/celeste/.openclaw/workspace/.secrets/firebase-service-account.json
 * Otherwise falls back to Firebase client SDK (requires Firestore rules to allow writes,
 * or use emulator, or set up App Check bypass).
 *
 * Run: node migrate-permits.js
 */

import { existsSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_ACCOUNT_PATH = '/Users/celeste/.openclaw/workspace/.secrets/firebase-service-account.json';
const PROJECT_ID = 'insulation-services-da91a';

// Load permits from the parent lib/permits.js (ESM)
const permitsPath = path.resolve(__dirname, '../lib/permits.js');
const { PERMITS } = await import(permitsPath);

console.log(`Loaded ${PERMITS.length} permits from lib/permits.js`);

let db;
let setDocFn;
let docFn;

if (existsSync(SERVICE_ACCOUNT_PATH)) {
  // ── Firebase Admin SDK path ──────────────────────────────────────────────
  console.log('Using Firebase Admin SDK with service account...');
  const admin = (await import('firebase-admin')).default;
  const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: PROJECT_ID,
  });
  db = admin.firestore();

  let migrated = 0;
  let failed = 0;
  const BATCH_SIZE = 400; // Firestore batch limit is 500

  for (let i = 0; i < PERMITS.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = PERMITS.slice(i, i + BATCH_SIZE);
    for (const permit of chunk) {
      const ref = db.collection('permits').doc(String(permit.id));
      batch.set(ref, permit);
    }
    try {
      await batch.commit();
      migrated += chunk.length;
      console.log(`  Committed batch ${Math.floor(i / BATCH_SIZE) + 1}: ${migrated} permits so far`);
    } catch (err) {
      console.error(`  Batch error: ${err.message}`);
      failed += chunk.length;
    }
  }

  console.log(`\nMigrated ${migrated} permits to Firestore${failed ? ` (${failed} failed)` : ''}`);

} else {
  // ── Firebase Client SDK path ─────────────────────────────────────────────
  console.log('No service account found. Using Firebase client SDK...');
  console.log('NOTE: This requires Firestore security rules to allow writes.');
  console.log('      If it fails with permission errors, add a service account file or');
  console.log('      temporarily set rules to allow all writes in Firebase Console.\n');

  const { initializeApp } = await import('firebase/app');
  const { getFirestore, doc, setDoc, writeBatch, collection } = await import('firebase/firestore');

  const app = initializeApp({
    apiKey: "AIzaSyBvL6M_2kPGt8XrcgpPHfL-bwU9BAH57Qk",
    authDomain: "insulation-services-da91a.firebaseapp.com",
    projectId: PROJECT_ID,
    storageBucket: "insulation-services-da91a.firebasestorage.app",
    messagingSenderId: "761459419108",
    appId: "1:761459419108:web:25235ad8b067eddb96c9f1",
  });
  db = getFirestore(app);

  let migrated = 0;
  let failed = 0;
  const BATCH_SIZE = 400;

  for (let i = 0; i < PERMITS.length; i += BATCH_SIZE) {
    const batch = writeBatch(db);
    const chunk = PERMITS.slice(i, i + BATCH_SIZE);
    for (const permit of chunk) {
      const ref = doc(collection(db, 'permits'), String(permit.id));
      batch.set(ref, permit);
    }
    try {
      await batch.commit();
      migrated += chunk.length;
      console.log(`  Committed batch ${Math.floor(i / BATCH_SIZE) + 1}: ${migrated} permits so far`);
    } catch (err) {
      console.error(`  Batch error: ${err.message}`);
      failed += chunk.length;
    }
  }

  console.log(`\nMigrated ${migrated} permits to Firestore${failed ? ` (${failed} failed)` : ''}`);
}
