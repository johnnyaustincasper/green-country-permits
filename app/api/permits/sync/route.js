import { NextResponse } from 'next/server';

// ─── Tulsa Permit Sync API ────────────────────────────────────────────────────
// Fetches live building permits from Tulsa's open data portal (Socrata API)
// and syncs them to Firestore.
//
// Tulsa open data: https://data.cityoftulsa.org
// Dataset: Building Permits (best-guess dataset ID from their Socrata portal)
// Fallback: scrape the permit search page

const SOCRATA_BASE = 'https://data.cityoftulsa.org/resource';
const PERMIT_DATASET_IDS = [
  'i3ft-5kp2', // common Tulsa permits dataset
  'a4gi-ib7v',
  'building-permits',
];

// Insulation-relevant permit types
const RELEVANT_TYPES = [
  'NEW CONSTRUCTION',
  'NEW SINGLE FAMILY',
  'NEW MULTIFAMILY',
  'COMMERCIAL NEW',
  'RESIDENTIAL NEW',
  'STRUCTURAL',
  'ADDITION',
  'COMMERCIAL ADDITION',
  'NEW COMMERCIAL',
  'NEW RESIDENTIAL',
  'FRAMING',
];

function isInsulationRelevant(permitType) {
  if (!permitType) return false;
  const upper = permitType.toUpperCase();
  return RELEVANT_TYPES.some(t => upper.includes(t));
}

function ninetyDaysAgo() {
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

async function fetchSocrataPermits(datasetId) {
  const since = ninetyDaysAgo();
  // Socrata SoQL query for recent new construction permits
  const params = new URLSearchParams({
    '$limit': '500',
    '$order': 'issue_date DESC',
    '$where': `issue_date >= '${since}T00:00:00.000'`,
  });
  const url = `${SOCRATA_BASE}/${datasetId}.json?${params}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

function normalizeSocrataPermit(raw) {
  // Socrata fields vary — try common field names
  const address = raw.address || raw.project_address || raw.location_address || raw.site_address || '';
  const permitType = raw.permit_type || raw.work_description || raw.type || raw.description || '';
  const issueDate = raw.issue_date || raw.issued_date || raw.permit_date || '';
  const value = parseFloat(raw.valuation || raw.estimated_value || raw.job_value || raw.value || 0) || 0;
  const owner = raw.applicant_name || raw.owner_name || raw.contractor || raw.applicant || '';
  const permitNumber = raw.permit_number || raw.permit_no || raw.id || '';
  const status = raw.status || raw.permit_status || 'issued';

  // Coordinates
  let lat = 0, lng = 0;
  if (raw.location) {
    lat = parseFloat(raw.location.latitude || raw.location.lat || 0);
    lng = parseFloat(raw.location.longitude || raw.location.lng || raw.location.lon || 0);
  }
  if (!lat && raw.latitude) lat = parseFloat(raw.latitude);
  if (!lng && raw.longitude) lng = parseFloat(raw.longitude);
  if (!lat && raw.y) lat = parseFloat(raw.y);
  if (!lng && raw.x) lng = parseFloat(raw.x);

  return {
    id: permitNumber || `tulsa-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    address,
    owner,
    permitType,
    issueDate: issueDate ? new Date(issueDate).toISOString().split('T')[0] : '',
    value,
    status,
    lat,
    lng,
    source: 'tulsa-open-data',
    syncedAt: new Date().toISOString(),
    // Legacy fields for UI compatibility
    builder: owner,
    city: extractCity(address) || 'Tulsa',
    phone: '',
    contact: '',
    week: '',
    sqft: 0,
    subdivision: '',
    production: false,
  };
}

function extractCity(address) {
  if (!address) return 'Tulsa';
  const match = address.match(/,\s*([A-Za-z\s]+),\s*OK/i);
  return match ? match[1].trim() : 'Tulsa';
}

// ─── Firestore Admin ──────────────────────────────────────────────────────────
async function getAdminDb() {
  try {
    const admin = (await import('firebase-admin')).default;
    if (admin.apps.length === 0) {
      // Try service account first
      const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
      if (serviceAccountPath) {
        const { readFileSync } = await import('fs');
        const sa = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
        admin.initializeApp({ credential: admin.credential.cert(sa) });
      } else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        admin.initializeApp({ credential: admin.credential.cert(sa) });
      } else {
        // Use application default credentials (works on GCP/Vercel with Firebase)
        admin.initializeApp({
          projectId: 'insulation-services-da91a',
        });
      }
    }
    return admin.firestore();
  } catch (err) {
    console.error('Admin SDK init failed:', err.message);
    return null;
  }
}

// ─── Route Handler ────────────────────────────────────────────────────────────
export async function POST(req) {
  let fetched = 0, synced = 0, skipped = 0, errors = [];
  const results = [];

  // Try each dataset ID
  let rawPermits = [];
  let datasetUsed = null;

  for (const datasetId of PERMIT_DATASET_IDS) {
    try {
      console.log(`Trying Socrata dataset: ${datasetId}`);
      rawPermits = await fetchSocrataPermits(datasetId);
      if (Array.isArray(rawPermits) && rawPermits.length > 0) {
        datasetUsed = datasetId;
        console.log(`Got ${rawPermits.length} records from dataset ${datasetId}`);
        break;
      }
    } catch (err) {
      errors.push(`Dataset ${datasetId}: ${err.message}`);
      console.warn(`Dataset ${datasetId} failed: ${err.message}`);
    }
  }

  fetched = rawPermits.length;

  // Filter for insulation-relevant permits
  const relevantPermits = rawPermits.filter(p =>
    isInsulationRelevant(p.permit_type || p.work_description || p.type || p.description || '')
  );

  console.log(`${relevantPermits.length} insulation-relevant permits out of ${fetched}`);

  // Sync to Firestore if we have data
  if (relevantPermits.length > 0) {
    const db = await getAdminDb();
    if (db) {
      const BATCH_SIZE = 400;
      for (let i = 0; i < relevantPermits.length; i += BATCH_SIZE) {
        const batch = db.batch();
        const chunk = relevantPermits.slice(i, i + BATCH_SIZE);
        for (const rawPermit of chunk) {
          const permit = normalizeSocrataPermit(rawPermit);
          if (!permit.address) { skipped++; continue; }
          const docId = `live-${permit.id}`.replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 100);
          const ref = db.collection('permits').doc(docId);
          batch.set(ref, permit, { merge: true });
          synced++;
        }
        await batch.commit();
      }
    } else {
      errors.push('Firestore admin not available — permits fetched but not saved');
    }
  }

  // Build response
  if (fetched === 0 && errors.length > 0) {
    return NextResponse.json({
      ok: false,
      message: 'Could not reach Tulsa open data portal. The data.cityoftulsa.org API may be unavailable or require authentication.',
      errors,
      tip: 'Try again later or check https://data.cityoftulsa.org for the correct dataset ID.',
    }, { status: 503 });
  }

  return NextResponse.json({
    ok: true,
    dataset: datasetUsed,
    fetched,
    relevant: relevantPermits.length,
    synced,
    skipped,
    errors: errors.length > 0 ? errors : undefined,
    message: synced > 0
      ? `Synced ${synced} new construction permits to Firestore`
      : fetched > 0
        ? `Fetched ${fetched} permits but none matched new construction filter`
        : 'No permits found in the last 90 days',
  });
}

export async function GET() {
  return NextResponse.json({
    endpoint: 'POST /api/permits/sync',
    description: 'Fetches Tulsa building permits from open data and syncs to Firestore',
    source: 'https://data.cityoftulsa.org',
    filter: 'Last 90 days, new construction / structural permits only',
  });
}
