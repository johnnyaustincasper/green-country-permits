#!/usr/bin/env node
// ─── Permit Alerts by Territory ───────────────────────────────────────────────
// Checks Firestore for permits issued in the last 24 hours that haven't
// been alerted yet, groups by territory/salesman, and sends Telegram messages.
//
// Run as a cron job (e.g. daily at 7am):
//   0 7 * * * cd /path/to/ISTpermits/scripts && node permit-alerts.mjs
//
// Env vars:
//   TELEGRAM_BOT_TOKEN  — Telegram bot token (required)
//   TELEGRAM_CHAT_ID    — Telegram chat ID (defaults to Johnny's chat)

import { initializeApp, getApps } from 'firebase/app';
import {
  getFirestore, collection, getDocs, doc, updateDoc,
  query, where, Timestamp,
} from 'firebase/firestore';

// ─── Config ───────────────────────────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID || '6357466021';

if (!TELEGRAM_BOT_TOKEN) {
  console.error('❌  TELEGRAM_BOT_TOKEN is not set. Exiting.');
  process.exit(1);
}

// Firebase client SDK (same config as the app)
const firebaseConfig = {
  apiKey:            'AIzaSyBvL6M_2kPGt8XrcgpPHfL-bwU9BAH57Qk',
  projectId:         'insulation-services-da91a',
  storageBucket:     'insulation-services-da91a.firebasestorage.app',
  messagingSenderId: '761459419108',
  appId:             '1:761459419108:web:25235ad8b067eddb96c9f1',
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db  = getFirestore(app);

// ─── Territory helpers ────────────────────────────────────────────────────────
const SALESMAN_COLORS = {
  Johnny: '🟢',
  Jordan: '🟣',
  Skip:   '🟠',
};

const TERRITORIES = {
  Johnny: ['tulsa', 'broken arrow', 'jenks', 'bixby', 'glenpool', 'sapulpa'],
  Jordan: ['catoosa', 'claremore', 'coweta', 'wagoner', 'muskogee', 'pryor', 'tahlequah', 'checotah'],
  Skip:   ['owasso', 'collinsville', 'skiatook', 'sand springs', 'okmulgee', 'bartlesville', 'nowata', 'vinita'],
};

const CITY_TO_SALESMAN = {};
Object.entries(TERRITORIES).forEach(([salesman, cities]) => {
  cities.forEach(city => { CITY_TO_SALESMAN[city] = salesman; });
});

function getSalesmanForPermit(permit) {
  const city = (permit.city || '').toLowerCase().trim();
  return CITY_TO_SALESMAN[city] || 'Johnny';
}

// ─── Telegram ─────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      chat_id:    TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram error: ${JSON.stringify(data)}`);
  return data;
}

// ─── Format helpers ───────────────────────────────────────────────────────────
function fmt(v) {
  const n = Number(v) || 0;
  return n > 0 ? `$${n.toLocaleString()}` : 'N/A';
}

function formatPermitLine(p) {
  const addr    = [p.address, p.city].filter(Boolean).join(', ');
  const jobType = p.permitType || p.permit_type || p.type || 'Unknown type';
  const val     = fmt(p.value);
  return `• <b>${addr}</b>\n  ${jobType} · ${val}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🔍  Checking for new permits in the last 24 hours…');

  // 24h ago
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const cutoffStr = cutoff.toISOString().split('T')[0]; // YYYY-MM-DD

  // Fetch all permits and filter client-side (avoids index requirements)
  const snapshot = await getDocs(collection(db, 'permits'));
  const allPermits = snapshot.docs.map(d => ({ _docId: d.id, ...d.data() }));

  // Filter: issued in last 24h AND not yet alerted
  const newPermits = allPermits.filter(p => {
    if (p.alerted) return false;
    // Support both issuedDate and issueDate fields
    const issued = p.issuedDate || p.issueDate || '';
    if (!issued) return false;
    // Compare date strings (YYYY-MM-DD)
    return issued >= cutoffStr;
  });

  console.log(`📋  Found ${newPermits.length} new unalerted permits.`);

  if (newPermits.length === 0) {
    console.log('✅  Nothing to send.');
    return;
  }

  // Group by salesman
  const grouped = { Johnny: [], Jordan: [], Skip: [] };
  for (const p of newPermits) {
    const salesman = getSalesmanForPermit(p);
    if (!grouped[salesman]) grouped[salesman] = [];
    grouped[salesman].push(p);
  }

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });

  // Send one message per salesman (only if they have permits)
  const docIdsToMark = [];

  for (const [salesman, permits] of Object.entries(grouped)) {
    if (permits.length === 0) continue;

    const emoji    = SALESMAN_COLORS[salesman] || '⚪';
    const lines    = permits.map(formatPermitLine).join('\n\n');
    const message  = [
      `${emoji} <b>New Permits — ${salesman}</b> · ${today}`,
      `${permits.length} permit${permits.length !== 1 ? 's' : ''} in the last 24 hours:\n`,
      lines,
    ].join('\n');

    try {
      await sendTelegram(message);
      console.log(`✅  Sent ${permits.length} permit(s) for ${salesman}`);
      permits.forEach(p => docIdsToMark.push(p._docId));
    } catch (err) {
      console.error(`❌  Failed to send for ${salesman}:`, err.message);
    }

    // Small delay between messages
    await new Promise(r => setTimeout(r, 500));
  }

  // Mark permits as alerted in Firestore
  if (docIdsToMark.length > 0) {
    console.log(`🔖  Marking ${docIdsToMark.length} permits as alerted…`);
    await Promise.all(
      docIdsToMark.map(id =>
        updateDoc(doc(db, 'permits', id), { alerted: true, alertedAt: new Date().toISOString() })
      )
    );
    console.log('✅  Done.');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
