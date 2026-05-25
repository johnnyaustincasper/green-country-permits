// ─── Territory Configuration ─────────────────────────────────────────────────
// City-based territory assignments for IST salesmen

export const SALESMAN_COLORS = {
  Johnny: '#00D47E',  // green  — central Tulsa
  Jordan: '#8b5cf6',  // purple — east / SE
  Skip:   '#f97316',  // orange — north / west
};

// Which cities each salesman covers
const TERRITORIES = {
  Johnny: [
    'Tulsa', 'Broken Arrow', 'Jenks', 'Bixby',
    'Glenpool', 'Sapulpa',
  ],
  Jordan: [
    'Catoosa', 'Claremore', 'Coweta', 'Wagoner',
    'Muskogee', 'Pryor', 'Tahlequah', 'Checotah',
  ],
  Skip: [
    'Owasso', 'Collinsville', 'Skiatook', 'Sand Springs',
    'Okmulgee', 'Bartlesville', 'Nowata', 'Vinita',
  ],
};

// Reverse map: city (lowercase) → salesman
const CITY_TO_SALESMAN = {};
Object.entries(TERRITORIES).forEach(([salesman, cities]) => {
  cities.forEach(city => {
    CITY_TO_SALESMAN[city.toLowerCase()] = salesman;
  });
});

/** Returns the assigned salesman for a permit based on city. */
export function getSalesmanForPermit(permit) {
  const city = (permit.city || '').toLowerCase().trim();
  return CITY_TO_SALESMAN[city] || 'Johnny'; // Johnny catches unassigned
}

// ─── Week-string Parsing ──────────────────────────────────────────────────────
// Supported formats: "3/8-3/14"  "3-8 to 3-14-26"  "11/2-11/8"  "3-22 To 3-28-26"

function parseWeekStartDate(week) {
  if (!week) return null;
  const s = week.trim();
  // Match first M/D or M-D group
  const m1 = s.match(/^(\d{1,2})[\/\-](\d{1,2})/);
  if (!m1) return null;
  const month = parseInt(m1[1], 10);
  const day = parseInt(m1[2], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Try to find a 2-digit year at the end like "-26" or " 26"
  const yearMatch = s.match(/[\-\s](\d{2})$/i);
  const year = yearMatch ? 2000 + parseInt(yearMatch[1], 10) : new Date().getFullYear();
  return new Date(year, month - 1, day);
}

/** Returns true if the permit's week is within the last 7 days. */
export function isNewThisWeek(week) {
  const date = parseWeekStartDate(week);
  if (!date) return false;
  const now = new Date();
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(now.getDate() - 7);
  return date >= sevenDaysAgo && date <= now;
}

/** Returns age in days (9999 if unparseable). */
export function getPermitAge(week) {
  const date = parseWeekStartDate(week);
  if (!date) return 9999;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
}

// ─── Priority Score ───────────────────────────────────────────────────────────
/**
 * Returns a priority score 1–10 for a permit.
 * @param {object} permit  — permit object from Firestore
 * @param {string|null} status — current status key (called/quoted/won/pass/null)
 */
export function calculatePermitScore(permit, status) {
  let score = 5; // baseline

  // ── Value (up to +3 / -1) ──────────────────────────────────────────────────
  const value = Number(permit.value) || 0;
  if (value > 300000)      score += 3;
  else if (value > 150000) score += 2;
  else if (value > 75000)  score += 1;
  else if (value === 0)    score -= 1;

  // ── Type (up to +2) ────────────────────────────────────────────────────────
  // Custom / indie builders (production=false) are better leads for IST
  if (!permit.production)  score += 2;

  // ── Age (up to +2 / -1) ───────────────────────────────────────────────────
  const age = getPermitAge(permit.week);
  if (age <= 7)        score += 2;
  else if (age <= 30)  score += 1;
  else if (age > 90)   score -= 1;

  // ── Status (up to +1 / -2) ────────────────────────────────────────────────
  if (!status)              score += 1; // fresh — no one has touched it
  else if (status === 'called')  score += 0;
  else if (status === 'quoted')  score -= 1;
  else if (status === 'won' || status === 'pass') score -= 2;

  return Math.min(10, Math.max(1, Math.round(score)));
}

/** Returns a hex colour for a score value. */
export function getScoreColor(score) {
  if (!score) return '#6b7280';
  if (score >= 9) return '#ef4444';
  if (score >= 7) return '#f97316';
  if (score >= 5) return '#f59e0b';
  return '#6b7280';
}
