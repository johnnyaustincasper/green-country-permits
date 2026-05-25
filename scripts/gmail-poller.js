/**
 * gmail-poller.js
 * Watches Ivebeencelested@gmail.com for forwarded NOW Report emails,
 * downloads PDF attachments (Weekly Jobs only, skips "lien" files),
 * parses HOUSE-NEW permit entries, geocodes addresses, and pushes to Firestore.
 *
 * IMPORTANT: Gmail requires an "App Password" for IMAP access.
 * Regular Gmail passwords do NOT work with IMAP (Google blocks them).
 * To set up an App Password:
 *   1. Go to https://myaccount.google.com/security
 *   2. Enable 2-Step Verification if not already enabled
 *   3. Go to https://myaccount.google.com/apppasswords
 *   4. Create an App Password for "Mail" / "Other (Custom name)" → name it "IST Poller"
 *   5. Replace GMAIL_PASSWORD below (or set GMAIL_APP_PASSWORD env var) with the 16-char code
 *
 * Run: node gmail-poller.js
 * Env vars: NEXT_PUBLIC_MAPBOX_TOKEN, GMAIL_APP_PASSWORD (optional override)
 */

import Imap from 'imap';
import { simpleParser } from 'mailparser';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GEOCODE_CACHE_PATH = path.join(__dirname, 'geocode-cache.json');
const SERVICE_ACCOUNT_PATH = '/Users/celeste/.openclaw/workspace/.secrets/firebase-service-account.json';
const PROJECT_ID = 'insulation-services-da91a';

// ── Config ─────────────────────────────────────────────────────────────────
const GMAIL_USER = 'Ivebeencelested@gmail.com';
// NOTE: This is the regular password. Gmail IMAP requires an App Password.
// See instructions above. Set GMAIL_APP_PASSWORD env var to override.
const GMAIL_PASSWORD = process.env.GMAIL_APP_PASSWORD || '67676969Jc!';
const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

const PRODUCTION_BUILDERS = [
  'SIMMONS HOMES', 'D R HORTON', 'DR HORTON', 'CAPITAL HOMES',
  'EXECUTIVE HOMES', 'RAUSCH-COLEMAN', 'RAUSCH COLEMAN',
  'IDEAL HOMES', 'HOMES BY TABER'
];

function isProduction(builder) {
  const b = (builder || '').toUpperCase();
  return PRODUCTION_BUILDERS.some(p => b.includes(p));
}

// ── Geocode cache ───────────────────────────────────────────────────────────
function loadGeocodeCache() {
  if (existsSync(GEOCODE_CACHE_PATH)) {
    try { return JSON.parse(readFileSync(GEOCODE_CACHE_PATH, 'utf8')); } catch {}
  }
  return {};
}

function saveGeocodeCache(cache) {
  writeFileSync(GEOCODE_CACHE_PATH, JSON.stringify(cache, null, 2));
}

async function geocodeAddress(address, city, cache) {
  const key = `${address}, ${city}, OK`;
  if (cache[key]) return cache[key];

  if (!MAPBOX_TOKEN) {
    console.warn('  No NEXT_PUBLIC_MAPBOX_TOKEN set — skipping geocoding');
    return { lat: 0, lng: 0 };
  }

  await new Promise(r => setTimeout(r, 100)); // rate limit
  const query = encodeURIComponent(key);
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${query}.json?access_token=${MAPBOX_TOKEN}&country=US&limit=1&types=address,place`;
  try {
    const { default: fetch } = await import('node-fetch');
    const res = await fetch(url);
    const data = await res.json();
    if (data.features && data.features.length > 0) {
      const [lng, lat] = data.features[0].center;
      cache[key] = { lat, lng };
      saveGeocodeCache(cache);
      return { lat, lng };
    }
  } catch (err) {
    console.warn(`  Geocode error for "${key}": ${err.message}`);
  }
  return { lat: 0, lng: 0 };
}

// ── PDF Parser ──────────────────────────────────────────────────────────────
function parseWeekFromText(text, filename) {
  const combined = text + ' ' + filename;

  // Format: "3/8-3/14" or "03/08-03/14"
  const slashRange = combined.match(/(\d{1,2})\/(\d{1,2})-(\d{1,2})\/(\d{1,2})/);
  if (slashRange) {
    return `${parseInt(slashRange[1])}/${parseInt(slashRange[2])}-${parseInt(slashRange[3])}/${parseInt(slashRange[4])}`;
  }

  // Format: "3-8 to 3-14-26" or "3-8 to 3-14" (dash-separated with "to")
  const dashToRange = combined.match(/(\d{1,2})-(\d{1,2})\s+to\s+(\d{1,2})-(\d{1,2})(?:-\d{2,4})?/i);
  if (dashToRange) {
    return `${parseInt(dashToRange[1])}/${parseInt(dashToRange[2])}-${parseInt(dashToRange[3])}/${parseInt(dashToRange[4])}`;
  }

  // Try "Week of Month Day" style
  const altMatch = text.match(/week\s+of\s+(\w+\s+\d+)/i);
  if (altMatch) return altMatch[1];

  return 'unknown';
}

function parsePermitsFromPDF(text, filename) {
  const week = parseWeekFromText(text, filename);
  const permits = [];

  // The NOW Report PDF has everything compressed (no spaces between words).
  // Format per entry:
  //   N)BUILDERNAMECITIEHOUSE-NEWADDRESSSTREETTYPE
  //   (918)xxx-xxxx/(918)xxx-xxxxSQFTL##B##
  //   OWNERNAME$VALUE
  //   SUBDIVISION

  const BUILDER_NAME_MAP = {
    'SCHUBERMITCHELLHOMES': 'Schuber Mitchell Homes',
    'SCHUBERMITCHELL': 'Schuber Mitchell Homes',
    'DRHORTON': 'DR Horton',
    'DRHORTONHOMES': 'DR Horton',
    'SIMMONSHOMES': 'Simmons Homes',
    'EXECUTIVEHOMES': 'Executive Homes',
    'CAPITALHOMES': 'Capital Homes',
    'RAUSCHCOLEMANHOMES': 'Rausch Coleman Homes',
    'RAUSCH-COLEMANHOMES': 'Rausch Coleman Homes',
    'LENNAR': 'Lennar',
    'LENNARHOMES': 'Lennar',
    'HOFFMANHOMES': 'Hoffman Homes',
    'RUSTICHOMES': 'Rustic Homes',
    'TRUENORTHHOMES': 'True North Homes',
    'ADMIREHOMES': 'Admire Homes',
    'BLACKWATERSTRUCTURES': 'Blackwater Structures',
    'COZORTCUSTOMHOMES': 'Cozort Custom Homes',
    'COZORTCONSTRUCTION': 'Cozort Construction',
    'MONEYHOMES': 'Money Homes',
    'CLASSICPROPERTIES': 'Classic Properties',
    'GIBSONHOMES': 'Gibson Homes',
    'SOUTHERNHOMES': 'Southern Homes',
    'HIGHWESTHOMES': 'High West Homes',
    'MC2HOMES': 'MC2 Homes',
    'HENSLEYCUSTOMHOMES': 'Hensley Custom Homes',
    'TOCARACUSTOMHOMES': 'Tocara Custom Homes',
    'CRESCENTHOMEBUILDERS': 'Crescent Home Builders',
    'BORNAGAINRESTORED': 'Born Again Restored',
    'KETCHUMPROPERTIES': 'Ketchum Properties',
    'BGREENHOMES': 'B Green Homes',
    'LABELLAHOMES': 'La Bella Homes',
    'NORTHSTARCONTRACTORS': 'Northstar Contractors',
    'HOLMSWEETHOME': 'Holm Sweet Home',
    'SMALYGOPROPERTIES': 'Smalygo Properties',
    'S&JHOMES': 'S&J Homes',
    'DMPCUSTOMHOMES': 'DMP Custom Homes',
    'EJPHOMES': 'EJP Homes',
    'CAZECACONSTRUCTION': 'Cazeca Construction',
    'KEETERINVESTMENTS': 'Keeter Investments',
    'BDPROPERTIES': 'BD Properties',
    'CHRISBURTONHOMES': 'Chris Burton Homes',
    'DODSONBUILDINGGROUP': 'Dodson Building Group',
    'ENVISIONHOMES': 'Envision Homes',
    'JONATHANPRIDE': 'Jonathan Pride',
    'LEESIGNATUREPROPERTIES': 'Lee Signature Properties',
    'ALIGNDESIGNGROUP': 'Align Design Group',
    'BUTLERHOMES': 'Butler Homes',
    'BELAND&CATTLE': 'Beland & Cattle',
    'IDEALHOMES': 'Ideal Homes',
    'HOMESBYABER': 'Homes by Aber',
    'CONCEPTBUILDERS': 'Concept Builders',
    'ABBYHOMES': 'Abbey Homes',
    'MATHISHOMES': 'Mathis Homes',
  };

  function cleanBuilder(raw, cities) {
    const key = raw.toUpperCase().replace(/\s+/g, '').trim();
    if (BUILDER_NAME_MAP[key]) return BUILDER_NAME_MAP[key];
    // fallback: strip city, title-case
    let b = raw.toUpperCase();
    for (const cityKey of Object.keys(cities)) {
      if (b.endsWith(cityKey)) b = b.slice(0, -cityKey.length).trim();
    }
    return b.split(/(?=[A-Z][a-z])|(?<=[a-z])(?=[A-Z])|\s+/)
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ').trim();
  }

  const knownCities = {
    'BROKENARROW': 'Broken Arrow', 'TULSA': 'Tulsa', 'BIXBY': 'Bixby',
    'OWASSO': 'Owasso', 'JENKS': 'Jenks', 'CLAREMORE': 'Claremore',
    'WAGONER': 'Wagoner', 'SAPULPA': 'Sapulpa', 'GLENPOOL': 'Glenpool',
    'SKIATOOK': 'Skiatook', 'COWETA': 'Coweta', 'CATOOSA': 'Catoosa',
    'SANDSPRINGS': 'Sand Springs', 'INOLA': 'Inola', 'OOLOGAH': 'Oologah',
    'COLLINSVILLE': 'Collinsville', 'SPERRY': 'Sperry', 'VERDIGRIS': 'Verdigris',
    'BARTLESVILLE': 'Bartlesville',
  };

  // Split on numbered entries like "1)" "2)" ... "99)"
  const entryPattern = /(\d+\))([\s\S]*?)(?=\d+\)|Page\s*\d+|$)/g;
  let match;

  while ((match = entryPattern.exec(text)) !== null) {
    const block = match[2];
    if (!/HOUSE-NEW/i.test(block)) continue;

    try {
      // Phone — (918)xxx-xxxx pattern
      const phoneMatches = block.match(/\(\d{3}\)[\d\/-]+/g) || [];
      const phone = phoneMatches[0] ? phoneMatches[0].split('/')[0] : '';

      // Sqft — digits immediately after phone number(s), before L##B## or newline
      // e.g. "(918)779-55682,845" → 2845  or "(918)779-5568/(918)924-83712,845"
      const sqftMatch = block.match(/\(\d{3}\)[\d\/\-]+?([\d,]{3,7})(?:\s*L\d|\s*$|\n)/m);
      const sqft = sqftMatch ? parseInt(sqftMatch[1].replace(/,/g, '')) : 0;

      // Value — $xxx,xxx
      const valueMatch = block.match(/\$[\d,]+/);
      const value = valueMatch ? parseInt(valueMatch[0].replace(/[$,]/g, '')) : 0;

      // Address — digits + street suffix (compressed, e.g. "8117EJACKSONCIR")
      // After HOUSE-NEW, grab everything up to phone number
      const afterHouseNew = block.split(/HOUSE-NEW/i)[1] || '';
      const beforePhone = afterHouseNew.split(/\(\d{3}\)/)[0] || afterHouseNew;
      
      // Try to find address number + compressed street
      const addrRaw = beforePhone.trim();
      // Insert spaces: before digit runs, before all-caps sequences
      let address = addrRaw
        .replace(/(\d+)([A-Z])/g, '$1 $2')
        .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim();

      // Remove city name suffix if present
      for (const c of Object.keys(knownCities)) {
        if (address.toUpperCase().endsWith(c)) {
          address = address.slice(0, -c.length).trim();
        }
      }
      // Normalize to UPPERCASE to match existing permit format
      address = address.toUpperCase();

      // City — find which jurisdiction section this entry is in
      const textBefore = text.substring(0, match.index);
      let city = 'Tulsa';
      let lastCityPos = -1;
      for (const [key, val] of Object.entries(knownCities)) {
        const idx = textBefore.lastIndexOf(key);
        if (idx > lastCityPos) { lastCityPos = idx; city = val; }
      }

      // Builder — text before HOUSE-NEW, strip city name
      let builderRaw = (block.split(/HOUSE-NEW/i)[0] || '').trim();
      for (const c of Object.keys(knownCities)) {
        builderRaw = builderRaw.replace(new RegExp(c + '$', 'i'), '').trim();
      }
      let builder = cleanBuilder(builderRaw, knownCities);

      if (!address || address.length < 5) continue;

      permits.push({
        builder: builder || 'Unknown',
        address,
        city,
        sqft,
        value,
        contact: '',
        phone,
        week,
        production: isProduction(builder),
      });
    } catch (e) { /* skip malformed */ }
  }

  return permits;
}


// ── Firestore writer ─────────────────────────────────────────────────────────
async function getFirestore() {
  if (existsSync(SERVICE_ACCOUNT_PATH)) {
    const admin = (await import('firebase-admin')).default;
    if (!admin.apps.length) {
      const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: PROJECT_ID });
    }
    return { db: admin.firestore(), mode: 'admin' };
  } else {
    const { initializeApp, getApps } = await import('firebase/app');
    const { getFirestore: getClientFirestore, doc, setDoc, getDoc, collection } = await import('firebase/firestore');
    const app = getApps().length ? getApps()[0] : initializeApp({
      apiKey: "AIzaSyBvL6M_2kPGt8XrcgpPHfL-bwU9BAH57Qk",
      projectId: PROJECT_ID,
      storageBucket: "insulation-services-da91a.firebasestorage.app",
      messagingSenderId: "761459419108",
      appId: "1:761459419108:web:25235ad8b067eddb96c9f1",
    });
    return { db: getClientFirestore(app), mode: 'client' };
  }
}

async function permitExists(db, mode, id) {
  if (mode === 'admin') {
    const snap = await db.collection('permits').doc(id).get();
    return snap.exists;
  } else {
    const { doc, getDoc, collection } = await import('firebase/firestore');
    const snap = await getDoc(doc(db, 'permits', id));
    return snap.exists();
  }
}

async function savePermit(db, mode, id, data) {
  if (mode === 'admin') {
    await db.collection('permits').doc(id).set(data);
  } else {
    const { doc, setDoc, collection } = await import('firebase/firestore');
    await setDoc(doc(db, 'permits', id), data);
  }
}

// ── IMAP email fetcher ───────────────────────────────────────────────────────
function fetchUnreadEmails() {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: GMAIL_USER,
      password: GMAIL_PASSWORD,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
    });

    const emails = [];

    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err, box) => {
        if (err) { imap.end(); return reject(err); }

        imap.search(['UNSEEN'], (err, results) => {
          if (err) { imap.end(); return reject(err); }
          if (!results || results.length === 0) {
            console.log('  No unread emails found.');
            imap.end();
            return resolve([]);
          }

          console.log(`  Found ${results.length} unread email(s)`);
          const fetch = imap.fetch(results, { bodies: '', markSeen: true });

          fetch.on('message', (msg, seqno) => {
            let rawEmail = '';
            msg.on('body', (stream) => {
              stream.on('data', chunk => rawEmail += chunk.toString());
              stream.once('end', () => {
                emails.push(rawEmail);
              });
            });
          });

          fetch.once('error', err => console.warn('  Fetch error:', err.message));
          fetch.once('end', () => {
            imap.end();
          });
        });
      });
    });

    imap.once('end', () => resolve(emails));
    imap.once('error', err => reject(err));
    imap.connect();
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══ IST Gmail Poller ═══\n');

  let emailsChecked = 0;
  let pdfsFound = 0;
  let permitsParsed = 0;
  let permitsAdded = 0;
  let permitsSkipped = 0;

  // Connect to Firestore
  const { db, mode } = await getFirestore();
  console.log(`Firestore connected (${mode} mode)`);

  // Load geocode cache
  const geocodeCache = loadGeocodeCache();
  console.log(`Geocode cache: ${Object.keys(geocodeCache).length} entries\n`);

  // Fetch emails
  console.log('Connecting to Gmail IMAP...');
  let rawEmails;
  try {
    rawEmails = await fetchUnreadEmails();
  } catch (err) {
    console.error('IMAP connection failed:', err.message);
    console.error('\nIf you see an authentication error, Gmail requires an App Password.');
    console.error('See the instructions at the top of this file.');
    process.exit(1);
  }

  emailsChecked = rawEmails.length;
  console.log(`\nProcessing ${emailsChecked} email(s)...\n`);

  for (const raw of rawEmails) {
    let parsed;
    try {
      parsed = await simpleParser(raw);
    } catch (err) {
      console.warn('  Could not parse email:', err.message);
      continue;
    }

    const subject = parsed.subject || '';
    console.log(`Email: "${subject}"`);

    // Find PDF attachments
    const attachments = (parsed.attachments || []).filter(a => {
      const fn = (a.filename || '').toLowerCase();
      if (!fn.endsWith('.pdf')) return false;
      if (fn.includes('lien')) { console.log(`  Skipping lien file: ${a.filename}`); return false; }
      if (fn.includes('job') || fn.includes('weekly')) return true;
      // Also accept PDFs that don't match but are in a NOW report context
      if (subject.toLowerCase().includes('now') || subject.toLowerCase().includes('weekly') || subject.toLowerCase().includes('permit')) return true;
      return false;
    });

    if (attachments.length === 0) {
      console.log('  No matching PDF attachments\n');
      continue;
    }

    for (const attachment of attachments) {
      console.log(`  Processing PDF: ${attachment.filename}`);
      pdfsFound++;

      let pdfText;
      try {
        const data = await pdfParse(attachment.content);
        pdfText = data.text;
      } catch (err) {
        console.warn(`  PDF parse error: ${err.message}`);
        continue;
      }

      const newPermits = parsePermitsFromPDF(pdfText, attachment.filename);
      console.log(`  Parsed ${newPermits.length} HOUSE-NEW permits from PDF`);
      permitsParsed += newPermits.length;

      for (const permit of newPermits) {
        // Generate unique ID from address + week
        const idSource = `${permit.address}-${permit.week}`.toLowerCase().replace(/\s+/g, '-');
        const id = crypto.createHash('md5').update(idSource).digest('hex').slice(0, 16);

        // Geocode
        if (!permit.lat || !permit.lng) {
          const coords = await geocodeAddress(permit.address, permit.city, geocodeCache);
          permit.lat = coords.lat;
          permit.lng = coords.lng;
        }

        // Check for duplicates
        const exists = await permitExists(db, mode, id);
        if (exists) {
          console.log(`  Skip duplicate: ${permit.address}`);
          permitsSkipped++;
          continue;
        }

        // Save to Firestore
        try {
          await savePermit(db, mode, id, { id, ...permit });
          console.log(`  ✓ Added: ${permit.builder} @ ${permit.address}`);
          permitsAdded++;
        } catch (err) {
          console.error(`  ✗ Failed to save ${permit.address}: ${err.message}`);
        }
      }
    }
    console.log();
  }

  console.log('═══ Summary ═══');
  console.log(`Emails checked:   ${emailsChecked}`);
  console.log(`PDFs found:       ${pdfsFound}`);
  console.log(`Permits parsed:   ${permitsParsed}`);
  console.log(`Permits added:    ${permitsAdded}`);
  console.log(`Permits skipped:  ${permitsSkipped} (duplicates)`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
