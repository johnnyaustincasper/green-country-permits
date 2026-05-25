'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { CITIES, CITY_COORDS } from '../../lib/permits';
import { db } from '../../lib/firebase';
import { collection, getDocs, onSnapshot, query, where } from 'firebase/firestore';
import { geocodePermits, applyGeocodedCoords, clearGeocodeCache } from '../../lib/geocode';
import {
  loadNotes, saveNotes,
  loadStatuses, saveStatuses,
  loadRoute, saveRoute,
  loadVisitLog, saveVisitLog,
  loadDailyRoutes, saveDailyRoutes,
  loadSession, saveSession,
  subscribeUserState,
  buildVisitEntry,
} from '../../lib/userState';
import VisitModal from './VisitModal';
import Dashboard from './Dashboard';
import LeadHub from './LeadHub';
import { LIQUID_GLASS, glassStyle, glassButton, glassButtonGhost } from '../../lib/theme';
import {
  getSalesmanForPermit, isNewThisWeek, calculatePermitScore, getScoreColor, SALESMAN_COLORS,
} from '../../lib/territories';

// ─── Theme ────────────────────────────────────────────────────────────────────
const T = LIQUID_GLASS;

// Dark luxury sidebar colors (independent of T)
const D = {
  bg: '#0A0A0F',
  sidebar: 'rgba(10,10,15,0.92)',
  topbar: 'rgba(10,10,15,0.88)',
  accent: '#00D47E',
  accentBg: 'rgba(0,212,126,0.08)',
  accentBorder: 'rgba(0,212,126,0.25)',
  border: 'rgba(255,255,255,0.06)',
  borderSub: 'rgba(255,255,255,0.08)',
  text: '#F0F0F5',
  textSub: 'rgba(240,240,245,0.55)',
  textMuted: 'rgba(240,240,245,0.35)',
  hover: 'rgba(255,255,255,0.04)',
};

const STYLES = {
  satellite: 'mapbox://styles/mapbox/satellite-v9',
  hybrid: 'mapbox://styles/mapbox/satellite-streets-v12',
  streets: 'mapbox://styles/mapbox/light-v11',
};

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Parses month from week strings in any format:
// "3/8-3/14"  "3-8 to 3-14-26"  "11/2-11/8"  "3-22 To 3-28-26"
function weekToMonth(week) {
  if (!week) return 0;
  const m = parseInt((week || '').match(/(\d{1,2})[\/\-]/)?.[1] || '0');
  return (m >= 1 && m <= 12) ? m : 0;
}
const SALESMEN = ['Johnny', 'Jordan', 'Skip'];

const STATUSES = [
  { key: 'called',    label: 'Called',        color: '#f59e0b', dot: '#f59e0b' },
  { key: 'quoted',    label: 'Quoted',        color: '#8b5cf6', dot: '#8b5cf6' },
  { key: 'won',       label: 'Won ✓',         color: '#16a34a', dot: '#16a34a' },
  { key: 'pass',      label: 'Not Interested', color: '#6b7280', dot: '#9ca3af' },
];

function logVisitEntry(user, permit, statusKey, currentLog) {
  if (!permit || !statusKey || statusKey === 'pass') return currentLog;
  const today = new Date().toISOString().slice(0, 10);
  const existingIdx = currentLog.findIndex(e => e.permitId === String(permit.id) && e.date === today);
  const entry = buildVisitEntry(permit, statusKey);
  let updated;
  if (existingIdx >= 0) {
    updated = [...currentLog];
    updated[existingIdx] = entry;
  } else {
    updated = [entry, ...currentLog].slice(0, 500);
  }
  return updated;
}

// ─── Login Screen ─────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [step, setStep] = useState('pick');
  const [selectedUser, setSelectedUser] = useState(null);
  const [pin, setPin] = useState('');
  const [setupPin, setSetupPin] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [hasPin, setHasPin] = useState(null);

  async function handleSelectUser(name) {
    setSelectedUser(name);
    setPin(''); setSetupPin(''); setError('');
    setChecking(true);
    try {
      const res = await fetch(`/api/pin?user=${name}`);
      const data = await res.json();
      setHasPin(data.hasPin);
      setStep(data.hasPin ? 'pin' : 'setup');
    } catch {
      setError('Connection error.'); setStep('pin');
    } finally { setChecking(false); }
  }

  async function handlePinDigit(digit) {
    if (checking) return;

    if (step === 'setup') {
      const next = setupPin + digit;
      if (next.length > 4) return;
      setSetupPin(next);
      if (next.length === 4) { setStep('confirm'); setPin(''); setError(''); }
      return;
    }

    if (step === 'confirm') {
      const next = pin + digit;
      if (next.length > 4) return;
      setPin(next);
      if (next.length === 4) {
        if (next !== setupPin) {
          setError("PINs don't match. Try again.");
          setPin(''); setSetupPin(''); setStep('setup');
          return;
        }
        setChecking(true);
        try {
          await fetch('/api/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: selectedUser, pin: next, action: 'set' }) });
          saveSession(selectedUser);
          onLogin(selectedUser);
        } catch { setError('Connection error.'); } finally { setChecking(false); }
      }
      return;
    }

    const next = pin + digit;
    if (next.length > 4) return;
    setPin(next);
    if (next.length === 4) {
      setChecking(true);
      try {
        const res = await fetch('/api/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: selectedUser, pin: next }) });
        const data = await res.json();
        if (data.ok) { saveSession(selectedUser); onLogin(selectedUser); }
        else { setError('Wrong PIN. Try again.'); setPin(''); }
      } catch { setError('Connection error.'); setPin(''); }
      finally { setChecking(false); }
    }
  }

  function handleBackspace() {
    if (step === 'setup') setSetupPin(p => p.slice(0, -1));
    else setPin(p => p.slice(0, -1));
    setError('');
  }

  const displayPin = step === 'setup' ? setupPin : pin;
  const title = step === 'pick' ? 'Who are you?' :
    step === 'setup' ? 'Create your PIN' :
    step === 'confirm' ? 'Confirm your PIN' : `Hi, ${selectedUser}`;
  const subtitle = step === 'pick' ? 'Select your name to continue' :
    step === 'setup' ? "You'll use this every time you log in" :
    step === 'confirm' ? 'Enter your PIN one more time' : 'Enter your PIN';

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif' }}>
      <style>{`
        @keyframes kenburns {
          0%   { transform: scale(1.0) translate(0%,0%); }
          50%  { transform: scale(1.12) translate(-2%,-1%); }
          100% { transform: scale(1.0) translate(0%,0%); }
        }
        @keyframes authFadeIn {
          from { opacity:0; transform:translateY(16px); }
          to   { opacity:1; transform:translateY(0); }
        }
        .kb-img { position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center;animation:kenburns 20s ease-in-out infinite;transform-origin:center center; }
        .kb-overlay { position:absolute;inset:0;background:linear-gradient(to bottom,rgba(0,0,0,0.55) 0%,rgba(0,0,0,0.35) 50%,rgba(0,0,0,0.65) 100%); }
        .kb-content { animation:authFadeIn 0.45s cubic-bezier(0.16,1,0.3,1) both; }
        .kb-card { background:rgba(255,255,255,0.1)!important;backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.2)!important;box-shadow:0 4px 24px rgba(0,0,0,0.3)!important;transition:background 0.2s,transform 0.2s!important; }
        .kb-card:hover { background:rgba(255,255,255,0.18)!important;transform:translateY(-2px); }
      `}</style>
      <img className="kb-img" src="/tulsa.jpg" alt="" />
      <div className="kb-overlay" />
      <div className="kb-content" style={{ position:'relative', zIndex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', minHeight:'100vh', padding:'20px 24px 40px' }}>
      <div style={{ width: '100%', maxWidth: 360 }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.65)', letterSpacing: 3, textTransform: 'uppercase', marginBottom: 4 }}>Insulation Services of Tulsa</div>
          <div style={{ fontSize: 32, fontWeight: 900, color: '#fff', letterSpacing: 1 }}>IST Permits</div>
          <div style={{ width: 40, height: 2, background: T.blue, margin: '12px auto 0', borderRadius: 1 }} />
        </div>

        <div style={{ fontSize: 22, fontWeight: 700, color: '#fff', textAlign: 'center', marginBottom: 6 }}>{title}</div>
        <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.65)', textAlign: 'center', marginBottom: 32 }}>{subtitle}</div>

        {step === 'pick' && !checking && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {SALESMEN.map(name => (
              <button key={name} onClick={() => handleSelectUser(name)} className="kb-card" style={{
                padding: '18px 24px', borderRadius: 14, fontSize: 20, fontWeight: 700,
                color: '#fff', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', border: 'none', width: '100%',
              }}>{name}</button>
            ))}
          </div>
        )}

        {step === 'pick' && checking && (
          <div style={{ textAlign: 'center', color: T.textSub, fontSize: 15 }}>Loading…</div>
        )}

        {(step === 'pin' || step === 'setup' || step === 'confirm') && (
          <>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 16, marginBottom: 32 }}>
              {[0,1,2,3].map(i => (
                <div key={i} style={{
                  width: 18, height: 18, borderRadius: '50%',
                  background: i < displayPin.length ? T.blue : 'rgba(0,0,0,0.12)',
                  transition: 'background 0.15s',
                }} />
              ))}
            </div>

            {error && <div style={{ textAlign: 'center', color: '#dc2626', fontSize: 14, marginBottom: 16, fontWeight: 500 }}>{error}</div>}
            {checking && <div style={{ textAlign: 'center', color: T.textSub, fontSize: 14, marginBottom: 16 }}>Checking…</div>}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
              {[1,2,3,4,5,6,7,8,9,'',0,'⌫'].map((d, i) => {
                if (d === '') return <div key={i} />;
                return (
                  <button key={i} onClick={() => d === '⌫' ? handleBackspace() : handlePinDigit(String(d))}
                    disabled={checking}
                    style={{
                      padding: '20px 0', borderRadius: 14, fontSize: d === '⌫' ? 22 : 24, fontWeight: 600,
                      background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)', color: '#fff',
                      cursor: checking ? 'default' : 'pointer', fontFamily: 'inherit',
                      backdropFilter: 'blur(8px)',
                      WebkitTapHighlightColor: 'transparent',
                      opacity: checking ? 0.5 : 1,
                    }}>{d}</button>
                );
              })}
            </div>

            <button onClick={() => { setStep('pick'); setPin(''); setSetupPin(''); setError(''); }} style={{
              width: '100%', padding: '12px', background: 'none', border: 'none',
              color: 'rgba(255,255,255,0.55)', fontSize: 14, cursor: 'pointer', fontFamily: 'inherit',
            }}>← Back</button>
          </>
        )}
      </div>
      </div>
    </div>
  );
}

const STATUS_COLORS = { called: '#f59e0b', quoted: '#8b5cf6', won: '#16a34a', pass: '#9ca3af' };

function buildGeoJSON(permits, statuses = {}, showTerritories = false) {
  return {
    type: 'FeatureCollection',
    features: permits.filter(p => p.lat !== 0 && p.lng !== 0).map(p => {
      const st = statuses[p.id];
      const salesman = getSalesmanForPermit(p);
      const isNew = isNewThisWeek(p.week) ? 1 : 0;
      const score = calculatePermitScore(p, st || null);
      // When showTerritories is on, always use salesman color; otherwise status overrides
      const dotColor = (showTerritories || !st)
        ? (SALESMAN_COLORS[salesman] || '#2563eb')
        : STATUS_COLORS[st];
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        properties: {
          id: p.id, builder: p.builder, address: p.address, city: p.city,
          sqft: p.sqft, value: p.value, week: p.week, production: p.production,
          phone: p.phone, subdivision: p.subdivision, contact: p.contact,
          radius: Math.max(14, Math.sqrt((p.value || 50000) / 4000)),
          dotColor,
          salesman,
          isNew,
          score,
        },
      };
    }),
  };
}

function fmt(v) { return '$' + Number(v).toLocaleString(); }

function addLayers(map, data, onClickPermit) {
  // If source already exists, just update data — clustering is applied automatically by Mapbox
  if (map.getSource('permits')) {
    map.getSource('permits').setData(data);
    // Re-wire click handler
    if (map._permitClick) map.off('click', 'permits-hit', map._permitClick);
    map._permitClick = (e) => {
      const f = e.features[0];
      const p = f.properties;
      const [lng, lat] = f.geometry.coordinates;
      setTimeout(() => onClickPermit({ ...p, lat, lng, production: p.production === true || p.production === 'true' }), 0);
    };
    map.on('click', 'permits-hit', map._permitClick);
    return;
  }

  if (map.getLayer('permits-new-badge')) map.removeLayer('permits-new-badge');
  if (map.getLayer('permits-new-ring')) map.removeLayer('permits-new-ring');
  if (map.getLayer('permits-hit')) map.removeLayer('permits-hit');
  if (map.getLayer('permits-labels')) map.removeLayer('permits-labels');
  if (map.getLayer('permits-main')) map.removeLayer('permits-main');
  if (map.getSource('permits')) map.removeSource('permits');

  map.addSource('permits', {
    type: 'geojson',
    data,
  });

  // Individual permit circles
  map.addLayer({
    id: 'permits-main',
    type: 'circle',
    source: 'permits',
    paint: {
      'circle-radius': ['get', 'radius'],
      'circle-color': ['get', 'dotColor'],
      'circle-opacity': 0.85,
      'circle-stroke-width': 2.5,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-opacity': 0.9,
    },
  });

  // Hit area for individual permits (invisible, larger tap target)
  map.addLayer({
    id: 'permits-hit',
    type: 'circle',
    source: 'permits',
    paint: {
      'circle-radius': ['+', ['get', 'radius'], 14],
      'circle-opacity': 0,
      'circle-stroke-width': 0,
    },
  });

  // Labels for individual permits at high zoom
  map.addLayer({
    id: 'permits-labels',
    type: 'symbol',
    source: 'permits',
    minzoom: 13,
    layout: {
      'text-field': ['get', 'builder'],
      'text-size': 11,
      'text-offset': [0, -1.8],
      'text-anchor': 'bottom',
      'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
      'text-max-width': 12,
    },
    paint: {
      'text-color': '#ffffff',
      'text-halo-color': 'rgba(0,0,0,0.75)',
      'text-halo-width': 1.5,
    },
  });

  // "NEW" glow ring for fresh permits (issued last 7 days)
  map.addLayer({
    id: 'permits-new-ring',
    type: 'circle',
    source: 'permits',
    filter: ['==', ['get', 'isNew'], 1],
    paint: {
      'circle-radius': ['+', ['get', 'radius'], 5],
      'circle-color': 'rgba(0,0,0,0)',
      'circle-opacity': 0,
      'circle-stroke-width': 2.5,
      'circle-stroke-color': '#00D47E',
      'circle-stroke-opacity': 0.8,
    },
  }, 'permits-main');

  // "NEW" badge text above fresh permit pins
  map.addLayer({
    id: 'permits-new-badge',
    type: 'symbol',
    source: 'permits',
    filter: ['==', ['get', 'isNew'], 1],
    layout: {
      'text-field': '★ NEW',
      'text-size': 10,
      'text-offset': [0, -2.6],
      'text-anchor': 'bottom',
      'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
    },
    paint: {
      'text-color': '#00D47E',
      'text-halo-color': 'rgba(0,0,0,0.9)',
      'text-halo-width': 1.5,
    },
  });

  // Click individual permits
  if (map._permitClick) map.off('click', 'permits-hit', map._permitClick);
  map._permitClick = (e) => {
    const f = e.features[0];
    const p = f.properties;
    const [lng, lat] = f.geometry.coordinates;
    setTimeout(() => onClickPermit({ ...p, lat, lng, production: p.production === true || p.production === 'true' }), 0);
  };
  map.on('click', 'permits-hit', map._permitClick);
  map.on('mouseenter', 'permits-hit', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'permits-hit', () => { map.getCanvas().style.cursor = ''; });
}

// ─── Team Page ────────────────────────────────────────────────────────────────
function TeamPage({ activeUser, onClose, permits: allPermits, dailyRoutes, addToDailyRoute, removeFromDailyRoute, myRoute }) {
  const allDailyRoutes = useMemo(() => {
    const result = {};
    // Use the passed dailyRoutes for activeUser, load from localStorage for others
    SALESMEN.forEach(name => {
      if (name === activeUser) result[name] = dailyRoutes;
      else result[name] = loadDailyRoutes(name);
    });
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dailyRoutes, activeUser]);
  const today = new Date();
  const dow = today.getDay();
  const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const todayStr = today.toISOString().slice(0, 10);

  const statusColors = { called: '#f59e0b', quoted: '#8b5cf6', won: '#16a34a', route: T.blue, pass: '#9ca3af' };
  const statusLabels = { called: 'Called', quoted: 'Quoted', won: 'Won', route: 'Route', pass: 'Pass' };

  const [profileUser, setProfileUser] = useState(null);
  const [dayPlanner, setDayPlanner] = useState(null);
  const [plannerSearch, setPlannerSearch] = useState('');
  const [weekOffset, setWeekOffset] = useState(0);

  const monday = new Date(today);
  monday.setDate(today.getDate() - ((dow + 6) % 7) + weekOffset * 7);
  const weekDays = Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setDate(monday.getDate() + i); return d; });

  const teamData = SALESMEN.map(name => {
    const statuses = loadStatuses(name);
    const route = loadRoute(name);
    const visitLog = loadVisitLog(name);
    const activeStatuses = Object.entries(statuses).filter(([, s]) => s !== 'pass');
    const passStatuses = Object.entries(statuses).filter(([, s]) => s === 'pass');
    return { name, statuses, route, visitLog, activeStatuses, passStatuses };
  });

  const builderMap = {};
  teamData.forEach(({ name, statuses, route }) => {
    Object.entries(statuses).forEach(([id, status]) => {
      if (status === 'pass') return;
      const p = allPermits.find(p => String(p.id) === String(id)); if (!p) return;
      const key = p.builder.toLowerCase().trim();
      if (!builderMap[key]) builderMap[key] = [];
      builderMap[key].push({ user: name, permitId: id, address: p.address, status, builder: p.builder });
    });
    route.forEach(p => {
      const key = p.builder.toLowerCase().trim();
      if (!builderMap[key]) builderMap[key] = [];
      if (!builderMap[key].find(e => e.user === name && e.permitId === String(p.id)))
        builderMap[key].push({ user: name, permitId: String(p.id), address: p.address, status: 'route', builder: p.builder });
    });
  });
  const conflicts = Object.entries(builderMap).filter(([, entries]) => [...new Set(entries.map(e => e.user))].length > 1);

  if (profileUser) {
    const d = teamData.find(t => t.name === profileUser);
    const visitLog = loadVisitLog(profileUser);
    const totalVisited = d.activeStatuses.length;
    const byStatus = { called: 0, quoted: 0, won: 0 };
    d.activeStatuses.forEach(([, s]) => { if (byStatus[s] !== undefined) byStatus[s]++; });

    return (
      <div style={{ position: 'absolute', inset: 0, zIndex: 60, background: T.bg, display: 'flex', flexDirection: 'column', paddingTop: 'env(safe-area-inset-top,0px)', paddingBottom: 'env(safe-area-inset-bottom,0px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px 10px', borderBottom: `1px solid ${T.cardBorder}`, background: T.card }}>
          <button onClick={() => setProfileUser(null)} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: T.text, padding: '0 4px', fontFamily: 'inherit' }}>←</button>
          <div style={{ width: 36, height: 36, borderRadius: '50%', background: profileUser === activeUser ? T.blue : T.border, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 16, color: profileUser === activeUser ? '#fff' : T.textSub }}>{profileUser[0]}</div>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, color: T.text }}>{profileUser} {profileUser === activeUser && <span style={{ fontSize: 11, color: T.blue }}>(you)</span>}</div>
            <div style={{ fontSize: 11, color: T.textMuted }}>Salesman Profile</div>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 14px 24px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 18 }}>
            {[
              { label: 'Visited', value: totalVisited, color: T.blue },
              { label: 'Called', value: byStatus.called, color: '#f59e0b' },
              { label: 'Quoted', value: byStatus.quoted, color: '#8b5cf6' },
              { label: 'Won', value: byStatus.won, color: '#16a34a' },
            ].map(s => (
              <div key={s.label} style={{ background: T.card, border: `1px solid ${T.cardBorder}`, borderRadius: 12, padding: '12px 8px', textAlign: 'center', boxShadow: T.shadow }}>
                <div style={{ fontSize: 22, fontWeight: 900, color: s.color }}>{s.value}</div>
                <div style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>{s.label}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 20 }}>
            <div style={{ background: T.card, border: `1px solid ${T.cardBorder}`, borderRadius: 12, padding: '12px 8px', textAlign: 'center', boxShadow: T.shadow }}>
              <div style={{ fontSize: 22, fontWeight: 900, color: '#9ca3af' }}>{d.passStatuses.length}</div>
              <div style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Passed</div>
            </div>
            <div style={{ background: T.card, border: `1px solid ${T.cardBorder}`, borderRadius: 12, padding: '12px 8px', textAlign: 'center', boxShadow: T.shadow }}>
              <div style={{ fontSize: 22, fontWeight: 900, color: T.text }}>{d.route.length}</div>
              <div style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>On Route</div>
            </div>
          </div>

          <div style={{ fontSize: 13, fontWeight: 800, color: T.text, marginBottom: 10 }}>📋 Visit History</div>
          {visitLog.length === 0 ? (
            <div style={{ fontSize: 13, color: T.textMuted, fontStyle: 'italic', textAlign: 'center', padding: '20px 0' }}>No logged visits yet — statuses set going forward will appear here.</div>
          ) : (
            visitLog.map((entry, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: `1px solid ${T.cardBorder}` }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{entry.builder}</div>
                  <div style={{ fontSize: 11, color: T.textMuted }}>{entry.address?.split(',')[0]} {entry.city ? `· ${entry.city}` : ''}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: statusColors[entry.status], background: `${statusColors[entry.status]}18`, padding: '2px 8px', borderRadius: 5, display: 'block', marginBottom: 3 }}>{statusLabels[entry.status]}</span>
                  <span style={{ fontSize: 10, color: T.textMuted }}>{entry.date}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  if (dayPlanner) {
    const { dateStr, name } = dayPlanner;
    const dayRoute = ((allDailyRoutes[name] || {})[dateStr] || []);
    const isOwn = name === activeUser;
    const d = new Date(dateStr + 'T12:00:00');
    const dayLabel = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    const filteredPermits = allPermits.filter(p => {
      if (!plannerSearch.trim()) return true;
      const q = plannerSearch.toLowerCase();
      return (p.builder || '').toLowerCase().includes(q) || (p.address || '').toLowerCase().includes(q) || (p.city || '').toLowerCase().includes(q);
    }).slice(0, 30);

    return (
      <div style={{ position: 'absolute', inset: 0, zIndex: 60, background: T.bg, display: 'flex', flexDirection: 'column', paddingTop: 'env(safe-area-inset-top,0px)', paddingBottom: 'env(safe-area-inset-bottom,0px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px 10px', borderBottom: `1px solid ${T.cardBorder}`, background: T.card }}>
          <button onClick={() => { setDayPlanner(null); setPlannerSearch(''); }} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: T.text, padding: '0 4px', fontFamily: 'inherit' }}>←</button>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: T.text }}>🗓 {name}'s Route</div>
            <div style={{ fontSize: 11, color: T.textMuted }}>{dayLabel}</div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: T.blue }}>{dayRoute.length} stop{dayRoute.length !== 1 ? 's' : ''}</div>
            {dayRoute.length > 0 && (() => {
              const stops = dayRoute.map(p => encodeURIComponent((p.address || '') + (p.city ? ', ' + p.city + ', OK' : ', OK')));
              let mapsUrl;
              if (stops.length === 1) {
                mapsUrl = `maps://?daddr=${stops[0]}&dirflg=d`;
              } else {
                const chain = stops.join('+to:');
                mapsUrl = `maps://?daddr=${chain}&dirflg=d`;
              }
              return (
                <a href={mapsUrl} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 12px', borderRadius: 9, background: T.blue, color: '#fff', fontSize: 12, fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap' }}>
                  🗺 Map Route
                </a>
              );
            })()}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px 24px' }}>
          {dayRoute.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.blue, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Planned Stops</div>
              {dayRoute.map((p, idx) => (
                <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: `1px solid ${T.cardBorder}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 20, height: 20, borderRadius: '50%', background: T.blue, color: '#fff', fontSize: 10, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{idx + 1}</span>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{p.builder}</div>
                      <div style={{ fontSize: 11, color: T.textMuted }}>{p.address?.split(',')[0]}{p.city ? ` · ${p.city}` : ''}</div>
                    </div>
                  </div>
                  {isOwn && <button onClick={() => removeFromDailyRoute(dateStr, p.id)} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#dc2626', padding: '4px 6px' }}>✕</button>}
                </div>
              ))}
            </div>
          )}

          {isOwn && (
            <div>
              {myRoute && myRoute.length > 0 && (() => {
                const importable = myRoute.filter(p => !dayRoute.find(r => r.id === p.id));
                return importable.length > 0 ? (
                  <button onClick={() => importable.forEach(p => addToDailyRoute(dateStr, p))} style={{ width: '100%', padding: '11px 16px', borderRadius: 10, background: T.blueLight, border: `1.5px dashed ${T.blue}`, color: T.blue, fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', marginBottom: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                    📥 Import my route ({importable.length} builder{importable.length !== 1 ? 's' : ''})
                  </button>
                ) : (
                  <div style={{ fontSize: 12, color: T.textMuted, textAlign: 'center', marginBottom: 14, fontStyle: 'italic' }}>✓ All route builders already added</div>
                );
              })()}
              <div style={{ fontSize: 11, fontWeight: 700, color: T.textSub, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Add Builders</div>
              <input
                value={plannerSearch}
                onChange={e => setPlannerSearch(e.target.value)}
                placeholder="Search by name, address, city..."
                style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: `1px solid ${T.cardBorder}`, fontSize: 14, fontFamily: 'inherit', background: T.card, color: T.text, boxSizing: 'border-box', marginBottom: 10, outline: 'none' }}
              />
              {filteredPermits.map(p => {
                const already = dayRoute.find(r => r.id === p.id);
                return (
                  <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: `1px solid ${T.cardBorder}`, opacity: already ? 0.4 : 1 }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{p.builder}</div>
                      <div style={{ fontSize: 11, color: T.textMuted }}>{p.address?.split(',')[0]}{p.city ? ` · ${p.city}` : ''}</div>
                    </div>
                    <button onClick={() => { if (!already) addToDailyRoute(dateStr, p); }} disabled={!!already} style={{ padding: '6px 14px', borderRadius: 8, background: already ? T.bg : T.blue, color: already ? T.textMuted : '#fff', border: 'none', fontSize: 12, fontWeight: 700, cursor: already ? 'default' : 'pointer', fontFamily: 'inherit' }}>{already ? '✓' : '+ Add'}</button>
                  </div>
                );
              })}
              {filteredPermits.length === 0 && <div style={{ fontSize: 13, color: T.textMuted, fontStyle: 'italic', textAlign: 'center', padding: '12px 0' }}>No results</div>}
            </div>
          )}
          {!isOwn && dayRoute.length === 0 && <div style={{ fontSize: 13, color: T.textMuted, fontStyle: 'italic', textAlign: 'center', padding: '20px 0' }}>No stops planned for this day.</div>}
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 50, background: T.bg, display: 'flex', flexDirection: 'column', paddingTop: 'env(safe-area-inset-top,0px)', paddingBottom: 'env(safe-area-inset-bottom,0px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px 10px', borderBottom: `1px solid ${T.cardBorder}`, background: T.card }}>
        <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: T.text, padding: '0 4px', fontFamily: 'inherit' }}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: T.text }}>👥 Team</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
            <button onClick={() => setWeekOffset(w => w - 1)} style={{ background: 'none', border: 'none', fontSize: 16, cursor: 'pointer', color: T.textMuted, padding: '0 2px', fontFamily: 'inherit', lineHeight: 1 }}>‹</button>
            <span style={{ fontSize: 11, color: weekOffset === 0 ? T.blue : T.textMuted, fontWeight: weekOffset === 0 ? 700 : 400 }}>
              {weekOffset === 0 ? 'This week' : weekOffset === 1 ? 'Next week' : weekOffset === -1 ? 'Last week' : `${weekOffset > 0 ? '+' : ''}${weekOffset}w`}
              {' · '}{monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – {weekDays[6].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </span>
            <button onClick={() => setWeekOffset(w => w + 1)} style={{ background: 'none', border: 'none', fontSize: 16, cursor: 'pointer', color: T.textMuted, padding: '0 2px', fontFamily: 'inherit', lineHeight: 1 }}>›</button>
            {weekOffset !== 0 && <button onClick={() => setWeekOffset(0)} style={{ fontSize: 10, color: T.blue, background: T.blueLight, border: 'none', borderRadius: 5, padding: '2px 7px', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700 }}>Today</button>}
          </div>
        </div>
        {conflicts.length > 0 && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '4px 10px', fontSize: 11, fontWeight: 700, color: '#dc2626', flexShrink: 0 }}>⚠️ {conflicts.length}</div>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 12px 24px' }}>
        {conflicts.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#dc2626', marginBottom: 8 }}>⚠️ OVERLAPPING BUILDERS</div>
            {conflicts.map(([key, entries]) => {
              const builderName = entries[0].builder;
              const byUser = {};
              entries.forEach(e => { if (!byUser[e.user]) byUser[e.user] = []; byUser[e.user].push(e); });
              return (
                <div key={key} style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '10px 12px', marginBottom: 8 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: '#991b1b', marginBottom: 6 }}>{builderName}</div>
                  {Object.entries(byUser).map(([user, items]) => (
                    <div key={user} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: T.blue, minWidth: 52 }}>{user}</span>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {items.map((e, i) => <span key={i} style={{ fontSize: 10, fontWeight: 700, color: statusColors[e.status] || T.textSub, background: `${(statusColors[e.status] || '#ccc')}22`, padding: '2px 6px', borderRadius: 4 }}>{statusLabels[e.status] || e.status}</span>)}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}

        {teamData.map(({ name, route, activeStatuses, passStatuses }) => (
          <div key={name} style={{ marginBottom: 20, background: T.card, borderRadius: 14, border: `1px solid ${T.cardBorder}`, overflow: 'hidden', boxShadow: T.shadow }}>
            <button onClick={() => setProfileUser(name)} style={{ width: '100%', padding: '12px 14px', borderBottom: `1px solid ${T.cardBorder}`, display: 'flex', alignItems: 'center', gap: 10, background: name === activeUser ? T.blueLight : T.card, border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
              <div style={{ width: 36, height: 36, borderRadius: '50%', background: name === activeUser ? T.blue : T.border, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 15, color: name === activeUser ? '#fff' : T.textSub, flexShrink: 0 }}>{name[0]}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: name === activeUser ? T.blue : T.text }}>{name} {name === activeUser && <span style={{ fontSize: 10, fontWeight: 600 }}>(you)</span>}</div>
                <div style={{ fontSize: 11, color: T.textMuted }}>{route.length} route · {activeStatuses.length} active · {passStatuses.length} passed</div>
              </div>
              <span style={{ fontSize: 16, color: T.textMuted }}>›</span>
            </button>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
              {weekDays.map((d, i) => {
                const ds = d.toISOString().slice(0, 10);
                const isToday = ds === todayStr;
                const dayStops = ((allDailyRoutes[name] || {})[ds] || []);
                const isOwn = name === activeUser;
                return (
                  <button key={i} onClick={() => setDayPlanner({ dateStr: ds, name })} style={{ padding: '8px 2px', background: isToday ? T.blueLight : 'transparent', borderRight: i < 6 ? `1px solid ${T.cardBorder}` : 'none', borderBottom: 'none', borderTop: `1px solid ${T.cardBorder}`, borderLeft: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'center' }}>
                    <div style={{ fontSize: 9, fontWeight: 700, color: isToday ? T.blue : T.textMuted, textTransform: 'uppercase' }}>{DAY_LABELS[i]}</div>
                    <div style={{ fontSize: 14, fontWeight: isToday ? 800 : 500, color: isToday ? T.blue : T.text, marginTop: 1 }}>{d.getDate()}</div>
                    {dayStops.length > 0 && (
                      <div style={{ marginTop: 3, fontSize: 9, fontWeight: 700, background: `${T.blue}22`, color: T.blue, borderRadius: 3, padding: '1px 3px' }}>{dayStops.length}</div>
                    )}
                    {isOwn && isToday && dayStops.length === 0 && (
                      <div style={{ marginTop: 3, fontSize: 10, color: T.textMuted }}>+</div>
                    )}
                  </button>
                );
              })}
            </div>

            {activeStatuses.length > 0 && (
              <div style={{ padding: '10px 14px' }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: T.textSub, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>📋 Active ({activeStatuses.length})</div>
                {activeStatuses.slice(0, 5).map(([id, status]) => {
                  const permit = allPermits.find(p => String(p.id) === String(id));
                  if (!permit) return null;
                  return (
                    <div key={id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: `1px solid ${T.cardBorder}` }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: T.text }}>{permit.builder}</span>
                      <span style={{ fontSize: 10, fontWeight: 700, color: statusColors[status], background: `${statusColors[status]}18`, padding: '2px 7px', borderRadius: 5 }}>{statusLabels[status]}</span>
                    </div>
                  );
                })}
                {activeStatuses.length > 5 && <div style={{ fontSize: 11, color: T.textMuted, textAlign: 'center', marginTop: 6 }}>+{activeStatuses.length - 5} more — tap name to see all</div>}
              </div>
            )}
            {activeStatuses.length === 0 && <div style={{ padding: '12px 14px', fontSize: 12, color: T.textMuted, fontStyle: 'italic' }}>No active builders yet.</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Permit Score Badge ───────────────────────────────────────────────────────
function ScoreBadge({ score }) {
  const color = getScoreColor(score);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 28, height: 28, borderRadius: '50%',
      background: `${color}22`, border: `1.5px solid ${color}`,
      fontSize: 11, fontWeight: 800, color, flexShrink: 0,
    }}>{score}</span>
  );
}

// ─── Permit List ──────────────────────────────────────────────────────────────
function PermitList({ permits, statuses, activeUser, onClose, onSelectPermit }) {
  const [sortBy, setSortBy] = useState('score');
  const [filterNew, setFilterNew] = useState(false);
  const [filterMine, setFilterMine] = useState(false);

  const processed = permits.map(p => ({
    ...p,
    salesman: getSalesmanForPermit(p),
    isNew: isNewThisWeek(p.week),
    score: calculatePermitScore(p, statuses[p.id] || null),
  }));

  const filtered = processed
    .filter(p => !filterNew || p.isNew)
    .filter(p => !filterMine || p.salesman === activeUser);

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'score') return b.score - a.score;
    if (sortBy === 'new') {
      if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
      return b.score - a.score;
    }
    if (sortBy === 'value') return (Number(b.value) || 0) - (Number(a.value) || 0);
    return 0;
  });

  const newCount = processed.filter(p => p.isNew).length;
  const myCount = processed.filter(p => p.salesman === activeUser).length;

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 50,
      background: '#0A0A0F', display: 'flex', flexDirection: 'column',
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      paddingTop: 'env(safe-area-inset-top,0px)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '14px 16px 10px', borderBottom: '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(10,10,15,0.9)', flexShrink: 0,
      }}>
        <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#F0F0F5', padding: '0 4px', fontFamily: 'inherit' }}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: '#F0F0F5' }}>📋 Permits</div>
          <div style={{ fontSize: 11, color: 'rgba(240,240,245,0.4)', marginTop: 1 }}>
            {sorted.length} showing · {newCount} new this week · {myCount} mine
          </div>
        </div>
      </div>

      {/* Filter + sort bar */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={() => setFilterNew(v => !v)} style={{
          padding: '5px 12px', borderRadius: 20, fontSize: 12, fontWeight: 700,
          cursor: 'pointer', fontFamily: 'inherit',
          background: filterNew ? 'rgba(0,212,126,0.12)' : 'rgba(255,255,255,0.04)',
          border: filterNew ? '1px solid rgba(0,212,126,0.4)' : '1px solid rgba(255,255,255,0.08)',
          color: filterNew ? '#00D47E' : 'rgba(240,240,245,0.5)',
        }}>★ New This Week</button>
        <button onClick={() => setFilterMine(v => !v)} style={{
          padding: '5px 12px', borderRadius: 20, fontSize: 12, fontWeight: 700,
          cursor: 'pointer', fontFamily: 'inherit',
          background: filterMine ? 'rgba(0,212,126,0.12)' : 'rgba(255,255,255,0.04)',
          border: filterMine ? '1px solid rgba(0,212,126,0.4)' : '1px solid rgba(255,255,255,0.08)',
          color: filterMine ? '#00D47E' : 'rgba(240,240,245,0.5)',
        }}>👤 My Permits</button>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {[['score','⚡ Score'],['new','★ Newest'],['value','$ Value']].map(([k, label]) => (
            <button key={k} onClick={() => setSortBy(k)} style={{
              padding: '4px 10px', borderRadius: 8, fontSize: 11, fontWeight: 700,
              cursor: 'pointer', fontFamily: 'inherit',
              background: sortBy === k ? 'rgba(0,212,126,0.1)' : 'transparent',
              border: sortBy === k ? '1px solid rgba(0,212,126,0.4)' : '1px solid rgba(255,255,255,0.08)',
              color: sortBy === k ? '#00D47E' : 'rgba(240,240,245,0.4)',
            }}>{label}</button>
          ))}
        </div>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px 32px' }}>
        {sorted.length === 0 && (
          <div style={{ textAlign: 'center', padding: '60px 0', color: 'rgba(240,240,245,0.3)', fontSize: 14 }}>No permits match filters</div>
        )}
        {sorted.map(p => {
          const sColor = SALESMAN_COLORS[p.salesman] || '#2563eb';
          const scoreColor = getScoreColor(p.score);
          const st = statuses[p.id];
          return (
            <div key={p.id} onClick={() => onSelectPermit(p)} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 12px', marginBottom: 6,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.07)',
              borderLeft: `3px solid ${sColor}`,
              borderRadius: 10, cursor: 'pointer',
            }}>
              {/* Score badge */}
              <ScoreBadge score={p.score} />

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: '#F0F0F5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.builder}
                  </span>
                  {p.isNew && (
                    <span style={{
                      fontSize: 9, fontWeight: 800, letterSpacing: 0.5,
                      padding: '1px 5px', borderRadius: 3,
                      background: 'rgba(0,212,126,0.15)', color: '#00D47E',
                      border: '1px solid rgba(0,212,126,0.3)', flexShrink: 0,
                    }}>NEW</span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'rgba(240,240,245,0.4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.address?.split(',')[0]}{p.city ? ` · ${p.city}` : ''}{p.week ? ` · ${p.week}` : ''}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 3, alignItems: 'center' }}>
                  {Number(p.value) > 0 && (
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(240,240,245,0.55)' }}>${Number(p.value).toLocaleString()}</span>
                  )}
                  <span style={{
                    fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 3,
                    background: `${sColor}18`, color: sColor,
                    border: `1px solid ${sColor}33`,
                  }}>{p.salesman}</span>
                  {st && (
                    <span style={{
                      fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 3,
                      background: `${STATUS_COLORS[st]}18`, color: STATUS_COLORS[st],
                    }}>{st.toUpperCase()}</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function PermitMap() {
  const [activeUser, setActiveUser] = useState(() => loadSession());
  if (!activeUser) return <LoginScreen onLogin={setActiveUser} />;
  return <PermitMapInner activeUser={activeUser} onLogout={() => { saveSession(null); setActiveUser(null); }} />;
}

function PermitMapInner({ activeUser, onLogout }) {
  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const selectPermitRef = useRef(null);
  const sidebarRef = useRef(null);
  const [loaded, setLoaded] = useState(false);
  const [currentCity, setCurrentCity] = useState('All');
  const [customOnly, setCustomOnly] = useState(false);
  const [mapStyle, setMapStyle] = useState('hybrid');
  const [selected, setSelected] = useState(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [permits, setPermits] = useState([]);
  const [permitsLoading, setPermitsLoading] = useState(true);
  const [geocoding, setGeocoding] = useState(false);
  const [routeList, setRouteList] = useState(() => loadRoute(activeUser));
  const [currentMonth, setCurrentMonth] = useState('All');
  const [notes, setNotes] = useState(() => loadNotes(activeUser));
  const [noteText, setNoteText] = useState('');
  const [showRoutePanel, setShowRoutePanel] = useState(false);
  const [showTeamPanel, setShowTeamPanel] = useState(false);
  const [teamView, setTeamView] = useState(false);
  const [selectedPermit, setSelectedPermit] = useState(null);
  const [showVisitModal, setShowVisitModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showDashboard, setShowDashboard] = useState(false);
  const [showLeadHub, setShowLeadHub] = useState(false);
  const [newLeadsCount, setNewLeadsCount] = useState(0);
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const [dailyRoutes, setDailyRoutes] = useState(() => loadDailyRoutes(activeUser));
  const [statuses, setStatuses] = useState(() => loadStatuses(activeUser));
  const [myPermitsOnly, setMyPermitsOnly] = useState(false);
  const [newThisWeekOnly, setNewThisWeekOnly] = useState(false);
  const [showPermitList, setShowPermitList] = useState(false);
  const [visitLog, setVisitLog] = useState(() => loadVisitLog(activeUser));
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [showTerritories, setShowTerritories] = useState(false);

  const handleSelectBuilder = (builderName) => {
    setSearchQuery(builderName);
  };

  // Firestore real-time subscription for user state
  useEffect(() => {
    if (!activeUser) return;
    const unsub = subscribeUserState(activeUser, {
      onNotes: (notes) => setNotes(notes),
      onStatuses: (statuses) => setStatuses(statuses),
      onRoute: (permits) => setRouteList(permits),
      onVisitLog: (entries) => setVisitLog(entries),
      onDailyRoutes: (routes) => setDailyRoutes(routes),
    });
    return unsub;
  }, [activeUser]);

  // Click-outside to collapse sidebar
  useEffect(() => {
    function handleClickOutside(e) {
      if (sidebarRef.current && !sidebarRef.current.contains(e.target)) {
        setSidebarExpanded(false);
      }
    }
    if (sidebarExpanded) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [sidebarExpanded]);

  // Real-time new leads count for badge
  useEffect(() => {
    let fb = 0, re = 0;
    const update = () => setNewLeadsCount(fb + re);
    const unsub1 = onSnapshot(collection(db, 'fbLeads'), snap => {
      fb = snap.docs.filter(d => d.data().status === 'new').length;
      update();
    });
    const unsub2 = onSnapshot(collection(db, 'reLeads'), snap => {
      re = snap.docs.filter(d => d.data().status === 'new').length;
      update();
    });
    return () => { unsub1(); unsub2(); };
  }, []);

  // Load permits from Firestore on mount
  useEffect(() => {
    getDocs(collection(db, 'permits')).then(snapshot => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setPermits(data);
      setPermitsLoading(false);
    }).catch(err => {
      console.error('Failed to load permits from Firestore:', err);
      setPermitsLoading(false);
    });
  }, []);

  const isMobile = useRef(false);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      isMobile.current = window.innerWidth < 768;
    }
  }, []);

  const selectPermit = useCallback((props) => {
    setSelected(props);
    setShowRoutePanel(false);
    setNoteText('');
    if (mapRef.current) {
      const coords = [Number(props.lng || 0), Number(props.lat || 0)];
      if (coords[0] && coords[1]) {
        const cardHeight = isMobile.current ? Math.round(window.innerHeight * 0.55) + 40 : 300;
        mapRef.current.easeTo({ center: coords, padding: { bottom: cardHeight }, duration: 400 });
      }
    }
  }, []); // stable — uses only refs and setters

  // Keep selectPermitRef always pointing to latest selectPermit
  useEffect(() => { selectPermitRef.current = selectPermit; }, [selectPermit]);

  const closeDetail = useCallback(() => {
    setSelected(null);
    if (mapRef.current) mapRef.current.easeTo({ padding: { bottom: 0 }, duration: 300 });
  }, []);

  const saveNote = useCallback((id, text) => {
    const updated = { ...notes, [id]: text };
    setNotes(updated);
    saveNotes(activeUser, updated); // async Firestore write
  }, [notes, activeUser]);

  const setStatus = useCallback((id, statusKey, permit) => {
    setStatuses(prev => {
      const updated = statusKey ? { ...prev, [id]: statusKey } : Object.fromEntries(Object.entries(prev).filter(([k]) => k !== id));
      saveStatuses(activeUser, updated); // async Firestore write
      return updated;
    });
    if (permit && statusKey && statusKey !== 'pass') {
      setVisitLog(prev => {
        const updated = logVisitEntry(activeUser, permit, statusKey, prev || []);
        saveVisitLog(activeUser, updated);
        return updated;
      });
    }
  }, [activeUser]);

  const addToDailyRoute = useCallback((dateStr, permit) => {
    setDailyRoutes(prev => {
      const day = prev[dateStr] || [];
      if (day.find(p => p.id === permit.id)) return prev;
      const updated = { ...prev, [dateStr]: [...day, permit] };
      saveDailyRoutes(activeUser, updated); // async Firestore write
      return updated;
    });
  }, [activeUser]);

  const removeFromDailyRoute = useCallback((dateStr, permitId) => {
    setDailyRoutes(prev => {
      const updated = { ...prev, [dateStr]: (prev[dateStr] || []).filter(p => p.id !== permitId) };
      saveDailyRoutes(activeUser, updated); // async Firestore write
      return updated;
    });
  }, [activeUser]);

  const addToRoute = useCallback((permit) => {
    setRouteList(prev => {
      if (prev.find(p => p.id === permit.id)) return prev;
      const next = [...prev, permit];
      saveRoute(activeUser, next); // async Firestore write
      return next;
    });
  }, [activeUser]);

  const removeFromRoute = useCallback((id) => {
    setRouteList(prev => {
      const next = prev.filter(p => p.id !== id);
      saveRoute(activeUser, next); // async Firestore write
      return next;
    });
  }, [activeUser]);

  const clearRoute = useCallback(() => {
    setRouteList([]);
    saveRoute(activeUser, []);
  }, [activeUser]);

  const openAppleMapsRoute = useCallback(() => {
    if (routeList.length === 0) return;
    const addresses = routeList.map(p => p.address + ', ' + p.city + ', OK');
    if (addresses.length === 1) {
      window.open(`maps://?daddr=${encodeURIComponent(addresses[0])}&dirflg=d`, '_blank');
      return;
    }
    const first = encodeURIComponent(addresses[0]);
    const rest = addresses.slice(1).map(a => encodeURIComponent(a)).join('+to:');
    window.open(`maps://?saddr=&daddr=${first}+to:${rest}&dirflg=d`, '_blank');
  }, [routeList]);

  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

  // Geocoding now happens server-side via geocode-backfill.mjs — coords live in Firestore.
  // Client-side geocoding disabled to prevent setPermits re-render cascade on load.
  useEffect(() => { setGeocoding(false); }, []);

  const availableMonths = useMemo(() => {
    const seen = new Set();
    permits.forEach(p => {
      const m = weekToMonth(p.week);
      if (m) seen.add(m);
    });
    return ['All', ...Array.from(seen).sort((a,b) => a-b).map(m => MONTH_NAMES[m-1])];
  }, [permits]);

  const filtered = useMemo(() => {
    return permits.filter(p => {
      if (customOnly && p.production) return false;
      if (currentCity !== 'All' && p.city !== currentCity) return false;
      if (currentMonth !== 'All') {
        const m = weekToMonth(p.week);
        if (MONTH_NAMES[m-1] !== currentMonth) return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        if (!(p.builder || '').toLowerCase().includes(q) &&
            !(p.address || '').toLowerCase().includes(q) &&
            !(p.city || '').toLowerCase().includes(q)) {
          return false;
        }
      }
      if (myPermitsOnly && getSalesmanForPermit(p) !== activeUser) return false;
      if (newThisWeekOnly && !isNewThisWeek(p.week)) return false;
      return true;
    });
  }, [permits, customOnly, currentCity, currentMonth, searchQuery, myPermitsOnly, newThisWeekOnly, activeUser]);

  const geoJSON = useMemo(() => buildGeoJSON(filtered, statuses, showTerritories), [filtered, statuses, showTerritories]);

  useEffect(() => {
    if (!token || mapRef.current) return;
    mapboxgl.accessToken = token;
    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: STYLES.hybrid,
      center: [-95.85, 36.10],
      zoom: 10.3,
      pitch: 0,
      bearing: 0,
      antialias: false,
      fadeDuration: 0,
      trackResize: true,
      renderWorldCopies: false,
      touchPitch: false,
      touchZoomRotate: true,
    });
    map.scrollZoom.setWheelZoomRate(1/300);
    map.scrollZoom.setZoomRate(1/300);
    // Disable ALL competing gesture handlers
    map.touchPitch.disable();
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();

    // Disable Mapbox's built-in touchZoomRotate — it has a known iOS Safari jitter bug
    map.touchZoomRotate.disable();

    // Custom pinch zoom handler with deadzone to filter finger micro-jitter
    let lastDist = null;
    mapContainer.current.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 2) { lastDist = null; return; }
  e.preventDefault();
  const dx = e.touches[0].clientX - e.touches[1].clientX;
  const dy = e.touches[0].clientY - e.touches[1].clientY;
  lastDist = Math.sqrt(dx * dx + dy * dy);
}, { passive: false });

    mapContainer.current.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2 && lastDist) {
    e.preventDefault();
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const ratio = dist / lastDist;
    // 3% deadzone — ignore micro-jitter
    if (ratio > 0.97 && ratio < 1.03) return;
    // Clamp max zoom speed — prevent violent jumps
    const clampedRatio = Math.max(0.92, Math.min(1.08, ratio));
    const zoomDelta = (clampedRatio - 1) * 1.2;
    map.setZoom(map.getZoom() + zoomDelta);
    // CRITICAL: only update lastDist after a real zoom — not inside deadzone
    lastDist = dist;
  }
}, { passive: false });

    mapContainer.current.addEventListener('touchend', () => {
      lastDist = null;
    }, { passive: false });
    map.addControl(new mapboxgl.NavigationControl(), 'bottom-right');
    map.on('load', () => {
      // Skip 3D terrain — it hammers GPU during pan/zoom
      addLayers(map, buildGeoJSON([], loadStatuses()), (permit) => selectPermitRef.current(permit));
      setLoaded(true);
      map.flyTo({ center: [-95.88, 36.08], zoom: 10.5, pitch: 0, bearing: 0, duration: 1800 });
    });
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (!mapRef.current || !loaded) return;
    const src = mapRef.current.getSource('permits');
    if (src) src.setData(geoJSON);
  }, [geoJSON, loaded]);

  const flyToCity = useCallback((city) => {
    setCurrentCity(city);
    closeDetail();
    if (!mapRef.current) return;
    const coords = CITY_COORDS[city] || CITY_COORDS.All;
    mapRef.current.flyTo({ center: coords.center, zoom: coords.zoom, duration: 1000 });
  }, [closeDetail]);

  const changeStyle = useCallback((style) => {
    setMapStyle(style);
    if (!mapRef.current) return;
    const map = mapRef.current;
    map.setStyle(STYLES[style]);
    map.once('style.load', () => {
      addLayers(map, geoJSON, selectPermit);
    });
  }, [geoJSON, selectPermit]);

  const isInRoute = selected ? !!routeList.find(p => p.id === selected.id) : false;

  // Derived active nav state
  const activeNav = showLeadHub ? 'leads' : teamView ? 'team' : showDashboard ? 'intel' : showRoutePanel ? 'route' : panelOpen ? 'filters' : 'map';

  const handleNavClick = (item) => {
    if (item === 'map') {
      setPanelOpen(false);
      setShowRoutePanel(false);
      setSidebarExpanded(false);
      setShowLeadHub(false);
      setTeamView(false);
      setShowDashboard(false);
    } else if (item === 'filters') {
      const opening = !panelOpen;
      setPanelOpen(opening);
      setShowRoutePanel(false);
      setSidebarExpanded(opening);
    } else if (item === 'route') {
      const opening = !showRoutePanel;
      setShowRoutePanel(opening);
      setPanelOpen(false);
      setSidebarExpanded(opening);
    } else if (item === 'intel') {
      setShowDashboard(true);
      setShowLeadHub(false);
      setSidebarExpanded(false);
    } else if (item === 'team') {
      setTeamView(true);
      setShowLeadHub(false);
      setSidebarExpanded(false);
      setPanelOpen(false);
      setShowRoutePanel(false);
    } else if (item === 'leads') {
      setShowLeadHub(true);
      setTeamView(false);
      setShowDashboard(false);
      setSidebarExpanded(false);
      setPanelOpen(false);
      setShowRoutePanel(false);
    }
  };

  // Map style icons
  const styleIcons = { satellite: '🛰', hybrid: '🗺', streets: '🏙' };
  const styleLabels = { satellite: 'Satellite', hybrid: 'Hybrid', streets: 'Streets' };

  // User initials
  const initials = activeUser ? activeUser.slice(0, 2).toUpperCase() : '??';

  // Reminders badge (check upcomingReminders from Dashboard - simplified: just show bell icon)
  const SIDEBAR_WIDTH_COLLAPSED = 64;
  const SIDEBAR_WIDTH_EXPANDED = 240;
  const TOP_BAR_HEIGHT = 52;

  if (!token) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: T.bg }}>
        <div style={{ background: T.card, border: `1px solid ${T.cardBorder}`, borderRadius: 16, padding: 32, maxWidth: 500, width: '90%', textAlign: 'center', boxShadow: T.shadow }}>
          <h2 style={{ color: T.text, marginBottom: 8 }}>Mapbox Token Required</h2>
          <p style={{ color: T.textSub, fontSize: 15, lineHeight: 1.6 }}>Add <code style={{ background: T.blueLight, padding: '2px 8px', borderRadius: 4, color: T.blue }}>NEXT_PUBLIC_MAPBOX_TOKEN</code> to Vercel environment variables.</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100vh', position: 'relative', overflow: 'hidden', background: '#0A0A0F', fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", touchAction: 'none' }}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        .nav-item { transition: background 150ms ease, border-color 150ms ease !important; }
        .nav-item:hover { background: rgba(255,255,255,0.04) !important; }
        .nav-item.active { background: rgba(0,212,126,0.08) !important; border-left-color: #00D47E !important; }
        .map-style-btn { transition: background 150ms ease !important; }
        .map-style-btn:hover { background: rgba(255,255,255,0.08) !important; }
        .map-style-btn.active { background: rgba(0,212,126,0.1) !important; }

        /* Mobile bottom tab bar */
        @media (max-width: 767px) {
          .ist-sidebar { display: none !important; }
          .ist-topbar { left: 0 !important; }
          .ist-filter-panel { left: 0 !important; top: ${TOP_BAR_HEIGHT}px !important; width: 100% !important; max-width: 100% !important; border-radius: 0 !important; }
          .ist-bottom-tabs { display: flex !important; }
        }
        @media (min-width: 768px) {
          .ist-bottom-tabs { display: none !important; }
        }
      `}</style>

      {/* Map — full viewport */}
      <div ref={mapContainer} style={{ position: 'absolute', inset: 0, touchAction: 'none' }} />

      {/* Loading indicator */}
      {permitsLoading && (
        <div style={{
          position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          zIndex: 50,
          background: 'rgba(10,10,15,0.9)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 16, padding: '18px 28px',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <div style={{ width: 18, height: 18, borderRadius: '50%', border: '3px solid #00D47E', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite' }} />
          <span style={{ color: '#F0F0F5', fontSize: 14, fontWeight: 600 }}>Loading permits…</span>
        </div>
      )}

      {/* ── Top Bar ─────────────────────────────────────────────────────────── */}
      <div className="ist-topbar" style={{
        position: 'fixed',
        top: 0,
        left: SIDEBAR_WIDTH_COLLAPSED,
        right: 0,
        height: TOP_BAR_HEIGHT,
        zIndex: 15,
        background: D.topbar,
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderBottom: `1px solid ${D.border}`,
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 20,
        paddingRight: 16,
        gap: 12,
        touchAction: 'none',
      }}>
        {/* Center wordmark */}
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
          <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: 3, textTransform: 'uppercase' }}>
            <span style={{ color: '#00D47E' }}>IST</span>
            <span style={{ color: D.textSub }}> INTEL</span>
          </span>
        </div>

        {/* Right: sync button + salesman name + logout */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {/* Sync permits button */}
          <button
            onClick={async () => {
              setSyncing(true);
              setSyncMsg('');
              try {
                const res = await fetch('/api/permits/sync', { method: 'POST' });
                const data = await res.json();
                if (data.ok) {
                  setSyncMsg(data.synced > 0 ? `✓ +${data.synced} permits` : data.relevant > 0 ? '✓ Up to date' : '✓ No new permits');
                  if (data.synced > 0) {
                    // Reload permits from Firestore
                    const { getDocs, collection: col } = await import('firebase/firestore');
                    const { db: firestore } = await import('../../lib/firebase');
                    const snap = await getDocs(col(firestore, 'permits'));
                    setPermits(snap.docs.map(d => ({ id: d.id, ...d.data() })));
                  }
                } else {
                  setSyncMsg('⚠ ' + (data.message || 'Sync failed').slice(0, 40));
                }
              } catch (err) {
                setSyncMsg('⚠ Sync error');
              } finally {
                setSyncing(false);
                setTimeout(() => setSyncMsg(''), 4000);
              }
            }}
            disabled={syncing}
            title="Sync live Tulsa permits"
            style={{
              background: 'rgba(0,212,126,0.08)',
              border: '1px solid rgba(0,212,126,0.2)',
              borderRadius: 7,
              color: syncing ? D.textMuted : '#00D47E',
              cursor: syncing ? 'default' : 'pointer',
              padding: '5px 10px',
              fontSize: 11,
              fontWeight: 700,
              fontFamily: 'inherit',
              lineHeight: 1,
              whiteSpace: 'nowrap',
              display: 'flex', alignItems: 'center', gap: 5,
            }}
          >
            {syncing ? (
              <><span style={{ display: 'inline-block', animation: 'spin 0.8s linear infinite' }}>↻</span> Syncing…</>
            ) : syncMsg ? (
              syncMsg
            ) : (
              <>↻ Sync</>
            )}
          </button>
          <span style={{ fontSize: 13, fontWeight: 600, color: D.textSub, whiteSpace: 'nowrap' }}>{activeUser}</span>
          <span style={{ fontSize: 12, color: D.textMuted }}>
            {filtered.length} permits
          </span>
          <button
            onClick={onLogout}
            title="Log out"
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 7,
              color: D.textSub,
              cursor: 'pointer',
              padding: '5px 9px',
              fontSize: 13,
              lineHeight: 1,
            }}
          >⏻</button>
        </div>
      </div>

      {/* ── Left Sidebar ────────────────────────────────────────────────────── */}
      <div
        ref={sidebarRef}
        className="ist-sidebar"
        style={{
          position: 'fixed',
          left: 0,
          top: 0,
          bottom: 0,
          width: sidebarExpanded ? SIDEBAR_WIDTH_EXPANDED : SIDEBAR_WIDTH_COLLAPSED,
          zIndex: 20,
          background: D.sidebar,
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderRight: `1px solid ${D.border}`,
          display: 'flex',
          flexDirection: 'column',
          transition: 'width 200ms ease',
          overflow: 'hidden',
          touchAction: 'none',
        }}
      >
        {/* Logo area */}
        <div style={{
          height: TOP_BAR_HEIGHT,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: sidebarExpanded ? 18 : 0,
          justifyContent: sidebarExpanded ? 'flex-start' : 'center',
          borderBottom: `1px solid ${D.border}`,
          flexShrink: 0,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
        }}>
          {sidebarExpanded ? (
            <div>
              <div style={{ fontSize: 18, fontWeight: 900, color: '#00D47E', lineHeight: 1, letterSpacing: 1 }}>IST</div>
              <div style={{ fontSize: 9, fontWeight: 700, color: D.textSub, letterSpacing: 3, textTransform: 'uppercase', marginTop: 1 }}>INTEL</div>
            </div>
          ) : (
            <div style={{ fontSize: 14, fontWeight: 900, color: '#00D47E', letterSpacing: 0.5 }}>IST</div>
          )}
        </div>

        {/* Nav items */}
        <div style={{ flex: 1, paddingTop: 8, paddingBottom: 8 }}>
          {[
            { key: 'map',     icon: '🗺️', label: 'Map' },
            { key: 'filters', icon: '≡',  label: 'Filters' },
            { key: 'route',   icon: '📍', label: 'Route' },
            { key: 'intel',   icon: '📊', label: 'Intel' },
            { key: 'team',    icon: '👥', label: 'Team' },
            { key: 'leads',   icon: '🎯', label: 'Leads' },
          ].map(({ key, icon, label }) => {
            const isActive = activeNav === key;
            const showBadge = (key === 'route' && routeList.length > 0) || (key === 'leads' && newLeadsCount > 0);
            const badgeCount = key === 'route' ? routeList.length : key === 'leads' ? newLeadsCount : 0;
            return (
              <button
                key={key}
                onClick={() => handleNavClick(key)}
                title={!sidebarExpanded ? label : undefined}
                className={`nav-item${isActive ? ' active' : ''}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  width: '100%',
                  height: 48,
                  padding: '0 0 0 0',
                  paddingLeft: sidebarExpanded ? 18 : 0,
                  justifyContent: sidebarExpanded ? 'flex-start' : 'center',
                  background: isActive ? D.accentBg : 'transparent',
                  border: 'none',
                  borderLeft: isActive ? `3px solid #00D47E` : '3px solid transparent',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                  position: 'relative',
                }}
              >
                <span style={{ fontSize: key === 'filters' ? 20 : 16, flexShrink: 0, lineHeight: 1 }}>{icon}</span>
                {sidebarExpanded && (
                  <span style={{
                    fontSize: 13,
                    fontWeight: isActive ? 700 : 500,
                    color: isActive ? '#00D47E' : D.textSub,
                    opacity: sidebarExpanded ? 1 : 0,
                    transition: 'opacity 150ms ease',
                  }}>{label}</span>
                )}
                {showBadge && (
                  <span style={{
                    position: sidebarExpanded ? 'static' : 'absolute',
                    top: sidebarExpanded ? undefined : 8,
                    right: sidebarExpanded ? undefined : 8,
                    marginLeft: sidebarExpanded ? 'auto' : undefined,
                    marginRight: sidebarExpanded ? 16 : undefined,
                    background: '#00D47E',
                    color: '#0A0A0F',
                    fontSize: 10,
                    fontWeight: 800,
                    borderRadius: 10,
                    padding: '1px 6px',
                    minWidth: 18,
                    textAlign: 'center',
                    lineHeight: '16px',
                  }}>{badgeCount}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Bottom: map style + avatar + logout */}
        <div style={{ borderTop: `1px solid ${D.border}`, paddingTop: 8, paddingBottom: 'max(16px, env(safe-area-inset-bottom, 16px))', flexShrink: 0 }}>
          {/* Map style switcher */}
          {Object.keys(STYLES).map(s => (
            <button
              key={s}
              onClick={() => changeStyle(s)}
              title={styleLabels[s]}
              className={`map-style-btn${mapStyle === s ? ' active' : ''}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                width: '100%',
                height: 36,
                paddingLeft: sidebarExpanded ? 18 : 0,
                justifyContent: sidebarExpanded ? 'flex-start' : 'center',
                background: mapStyle === s ? D.accentBg : 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
              }}
            >
              <span style={{ fontSize: 14, flexShrink: 0 }}>{styleIcons[s]}</span>
              {sidebarExpanded && (
                <span style={{ fontSize: 12, color: mapStyle === s ? '#00D47E' : D.textMuted, fontWeight: mapStyle === s ? 700 : 400 }}>{styleLabels[s]}</span>
              )}
            </button>
          ))}

          <div style={{ height: 1, background: D.border, margin: '8px 0' }} />

          {/* Avatar */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            height: 44,
            paddingLeft: sidebarExpanded ? 14 : 0,
            justifyContent: sidebarExpanded ? 'flex-start' : 'center',
            overflow: 'hidden',
          }}>
            <div
              title={activeUser}
              style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: '#00D47E',
                color: '#0A0A0F',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11,
                fontWeight: 900,
                flexShrink: 0,
                letterSpacing: 0.5,
              }}
            >{initials}</div>
            {sidebarExpanded && (
              <span style={{ fontSize: 13, fontWeight: 600, color: D.textSub, whiteSpace: 'nowrap' }}>{activeUser}</span>
            )}
          </div>

          {/* Logout */}
          <button
            onClick={onLogout}
            title="Log out"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              width: '100%',
              height: 36,
              paddingLeft: sidebarExpanded ? 18 : 0,
              justifyContent: sidebarExpanded ? 'flex-start' : 'center',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'inherit',
              overflow: 'hidden',
              whiteSpace: 'nowrap',
            }}
          >
            <span style={{ fontSize: 14, flexShrink: 0, color: D.textMuted }}>⏻</span>
            {sidebarExpanded && <span style={{ fontSize: 12, color: D.textMuted }}>Log out</span>}
          </button>
        </div>
      </div>

      {/* ── Filter Panel (slides in beside sidebar) ─────────────────────────── */}
      {panelOpen && (
        <div
          className="ist-filter-panel"
          style={{
            position: 'fixed',
            top: TOP_BAR_HEIGHT,
            left: sidebarExpanded ? SIDEBAR_WIDTH_EXPANDED : SIDEBAR_WIDTH_COLLAPSED,
            width: 248,
            bottom: 0,
            zIndex: 10,
            background: 'rgba(10,10,15,0.88)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            borderRight: `1px solid ${D.border}`,
            overflowY: 'auto',
            paddingBottom: 24,
            transition: 'left 200ms ease',
            touchAction: 'none',
          }}
        >
          {/* City filter */}
          <div style={{ padding: '14px 14px 10px' }}>
            <div style={{ fontSize: 10, color: D.textMuted, letterSpacing: 2, fontWeight: 700, marginBottom: 10, textTransform: 'uppercase' }}>City</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {CITIES.map(c => (
                <button key={c} onClick={() => flyToCity(c)} style={filterBtn(currentCity === c)}>{c}</button>
              ))}
            </div>
          </div>

          <div style={{ height: 1, background: D.border }} />

          {/* Month filter */}
          <div style={{ padding: '14px 14px 10px' }}>
            <div style={{ fontSize: 10, color: D.textMuted, letterSpacing: 2, fontWeight: 700, marginBottom: 10, textTransform: 'uppercase' }}>Month</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {availableMonths.map(m => (
                <button key={m} onClick={() => { setCurrentMonth(m); closeDetail(); }} style={filterBtn(currentMonth === m)}>{m}</button>
              ))}
            </div>
          </div>

          <div style={{ height: 1, background: D.border }} />

          {/* Custom only toggle */}
          <div style={{ padding: '14px 14px 10px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={customOnly} onChange={e => { setCustomOnly(e.target.checked); closeDetail(); }} style={{ accentColor: '#00D47E', width: 16, height: 16 }} />
              <span style={{ fontSize: 13, color: D.text, fontWeight: 500 }}>Custom builders only</span>
            </label>
          </div>

          <div style={{ height: 1, background: D.border }} />

          {/* Territory & New-this-week filters */}
          <div style={{ padding: '14px 14px 10px' }}>
            <div style={{ fontSize: 10, color: D.textMuted, letterSpacing: 2, fontWeight: 700, marginBottom: 10, textTransform: 'uppercase' }}>Quick Filters</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button onClick={() => setMyPermitsOnly(v => !v)} style={{
                padding: '8px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                background: myPermitsOnly ? 'rgba(0,212,126,0.1)' : 'rgba(255,255,255,0.04)',
                border: myPermitsOnly ? '1px solid rgba(0,212,126,0.4)' : '1px solid rgba(255,255,255,0.08)',
                color: myPermitsOnly ? '#00D47E' : D.textSub,
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: SALESMAN_COLORS[activeUser] || '#00D47E', flexShrink: 0 }} />
                My Permits ({activeUser})
              </button>
              <button onClick={() => setNewThisWeekOnly(v => !v)} style={{
                padding: '8px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                background: newThisWeekOnly ? 'rgba(0,212,126,0.1)' : 'rgba(255,255,255,0.04)',
                border: newThisWeekOnly ? '1px solid rgba(0,212,126,0.4)' : '1px solid rgba(255,255,255,0.08)',
                color: newThisWeekOnly ? '#00D47E' : D.textSub,
              }}>
                ★ New This Week
              </button>
              <button onClick={() => { setShowPermitList(true); setPanelOpen(false); }} style={{
                padding: '8px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: D.textSub,
              }}>
                📋 View as List ›
              </button>
            </div>
            {/* Salesman territory legend */}
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 5 }}>
              {['Johnny','Jordan','Skip'].map(name => (
                <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 9, height: 9, borderRadius: '50%', background: SALESMAN_COLORS[name], flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: D.textMuted }}>{name}</span>
                </div>
              ))}
            </div>
          </div>

          <div style={{ height: 1, background: D.border }} />

          {/* Search + Legend */}
          <div style={{ padding: '14px 14px 10px' }}>
            <div style={{ fontSize: 10, color: D.textMuted, letterSpacing: 2, fontWeight: 700, marginBottom: 10, textTransform: 'uppercase' }}>Search & Legend</div>
            <input
              type="text"
              placeholder="Filter builders…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              style={{
                width: '100%',
                padding: '8px 10px',
                border: `1px solid rgba(255,255,255,0.1)`,
                borderRadius: 8,
                fontSize: 12,
                fontFamily: 'inherit',
                marginBottom: 10,
                boxSizing: 'border-box',
                background: 'rgba(255,255,255,0.05)',
                color: D.text,
                outline: 'none',
              }}
            />
            <div style={{ fontSize: 11, color: D.textMuted, marginBottom: 10 }}>
              {permits.filter(p => !searchQuery.trim() || (p.builder || '').toLowerCase().includes(searchQuery.toLowerCase())).length} of {permits.length} permits
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#2563eb', border: '2px solid rgba(255,255,255,0.3)', flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: D.textSub }}>Custom / Indie Builder</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#ea580c', border: '2px solid rgba(255,255,255,0.3)', flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: D.textSub }}>Production Builder</span>
            </div>
            <div style={{ fontSize: 11, color: D.textMuted, marginBottom: 6 }}>Circle size = permit value</div>
            {STATUSES.map(s => (
              <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <div style={{ width: 9, height: 9, borderRadius: '50%', background: s.color, flexShrink: 0 }} />
                <span style={{ fontSize: 12, color: D.textMuted }}>{s.label}</span>
              </div>
            ))}
            <button onClick={() => { clearGeocodeCache(); window.location.reload(); }} style={{
              marginTop: 10, width: '100%', padding: '7px 0', borderRadius: 8,
              background: 'rgba(255,255,255,0.04)', border: `1px solid rgba(255,255,255,0.08)`,
              color: D.textMuted, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
            }}>↺ Re-geocode addresses</button>

            {/* Map style switcher (shown in filter panel on mobile) */}
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 10, color: D.textMuted, letterSpacing: 2, fontWeight: 700, marginBottom: 8, textTransform: 'uppercase' }}>Map Style</div>
              <div style={{ display: 'flex', gap: 6 }}>
                {Object.keys(STYLES).map(s => (
                  <button key={s} onClick={() => changeStyle(s)} style={{
                    flex: 1,
                    padding: '8px 0',
                    borderRadius: 8,
                    fontSize: 11,
                    cursor: 'pointer',
                    fontWeight: mapStyle === s ? 700 : 500,
                    border: mapStyle === s ? `1.5px solid #00D47E` : `1px solid rgba(255,255,255,0.1)`,
                    background: mapStyle === s ? D.accentBg : 'rgba(255,255,255,0.04)',
                    color: mapStyle === s ? '#00D47E' : D.textSub,
                    fontFamily: 'inherit',
                    textTransform: 'capitalize',
                  }}>{s}</button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Route panel (bottom sheet) ───────────────────────────────────────── */}
      {showRoutePanel && !selected && (
        <div style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 25,
          background: 'rgba(10,10,15,0.96)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderTop: `1px solid rgba(255,255,255,0.08)`,
          borderRadius: '20px 20px 0 0',
          padding: '18px 18px',
          paddingBottom: 'max(24px, env(safe-area-inset-bottom, 24px))',
          maxHeight: '65vh',
          overflowY: 'auto',
          touchAction: 'none',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <span style={{ color: D.text, fontWeight: 800, fontSize: 17 }}>📍 Route — {routeList.length} stop{routeList.length !== 1 ? 's' : ''}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={clearRoute} style={{ ...darkGhostBtn, color: '#f59e0b' }}>Clear all</button>
              <button onClick={() => setShowRoutePanel(false)} style={darkGhostBtn}>✕</button>
            </div>
          </div>
          {routeList.map((p, i) => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, padding: '10px 12px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10 }}>
              <span style={{ color: '#00D47E', fontWeight: 800, fontSize: 15, minWidth: 22 }}>{i + 1}.</span>
              <div
                onClick={() => { selectPermit(p); setShowRoutePanel(false); }}
                style={{ flex: 1, cursor: 'pointer' }}
              >
                <div style={{ fontSize: 15, fontWeight: 700, color: D.text }}>{p.builder}</div>
                <div style={{ fontSize: 13, color: D.textSub }}>{p.address}, {p.city}</div>
                {p.phone && <div style={{ fontSize: 13, color: '#00D47E', marginTop: 2 }}>📞 {p.phone}</div>}
              </div>
              <button onClick={() => removeFromRoute(p.id)} style={{ background: 'none', border: 'none', color: D.textMuted, cursor: 'pointer', fontSize: 18, padding: '4px 6px' }}>✕</button>
            </div>
          ))}
          <button onClick={openAppleMapsRoute} style={{
            width: '100%', padding: '15px 0', borderRadius: 12, cursor: 'pointer',
            background: '#00D47E', border: 'none', color: '#0A0A0F',
            fontSize: 16, fontWeight: 800, fontFamily: 'inherit', marginTop: 6,
          }}>
            🗺 Open Route in Apple Maps
          </button>
        </div>
      )}

      {/* ── Detail card ─────────────────────────────────────────────────────── */}
      {selected && (
        <div
          onTouchStart={e => { e.currentTarget._swipeY = e.touches[0].clientY; }}
          onTouchMove={e => { e.preventDefault(); }}
          onTouchEnd={e => { const startY = e.currentTarget._swipeY || 0; const dy = e.changedTouches[0].clientY - startY; if (dy > 60) closeDetail(); }}
          style={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 20,
            background: 'rgba(10,10,15,0.97)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            borderRadius: '20px 20px 0 0',
            borderTop: '1px solid rgba(255,255,255,0.08)',
            padding: '14px 16px',
            paddingBottom: 'max(20px, env(safe-area-inset-bottom, 20px))',
            maxHeight: '35vh',
            overflowY: 'auto',
            touchAction: 'pan-y',
          }}>
          <div style={{ width: 40, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.15)', margin: '0 auto 10px' }} />

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: T.text, lineHeight: 1.1 }}>{selected.builder}</div>
                {isNewThisWeek(selected.week) && (
                  <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.5, padding: '2px 6px', borderRadius: 3, background: 'rgba(0,212,126,0.15)', color: '#00D47E', border: '1px solid rgba(0,212,126,0.3)', flexShrink: 0 }}>NEW</span>
                )}
              </div>
              <div style={{ fontSize: 12, color: T.textMuted }}>{selected.address}</div>
              {selected.week && (
                <div style={{ fontSize: 11, color: T.textSub, marginTop: 4, fontWeight: 600 }}>Week: {selected.week}</div>
              )}
              {(() => {
                const salesman = getSalesmanForPermit(selected);
                const sColor = SALESMAN_COLORS[salesman] || '#2563eb';
                const score = calculatePermitScore(selected, statuses[selected.id] || null);
                return (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4, background: `${sColor}18`, color: sColor, border: `1px solid ${sColor}33` }}>{salesman}</span>
                    <ScoreBadge score={score} />
                    <span style={{ fontSize: 10, color: T.textMuted }}>priority</span>
                  </div>
                );
              })()}
            </div>
            <button onClick={closeDetail} style={{ ...ghostBtn, marginLeft: 8, flexShrink: 0, padding: '4px 8px' }}>✕</button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6, marginBottom: 8 }}>
            {[
              { l: 'Value', v: Number(selected.value) > 0 ? fmt(Number(selected.value)) : 'N/A' },
              { l: 'Sq Ft', v: Number(selected.sqft) > 0 ? Number(selected.sqft).toLocaleString() : 'N/A' },
            ].map(f => (
              <div key={f.l} style={{ background: T.bg, borderRadius: 8, padding: '8px 10px' }}>
                <div style={{ fontSize: 10, color: T.textMuted, textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 2 }}>{f.l}</div>
                <div style={{ fontSize: 13, color: T.text, fontWeight: 700 }}>{f.v}</div>
              </div>
            ))}
          </div>

          {selected.phone && selected.phone !== 'N/A' && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: T.textMuted, textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 4 }}>Call</div>
              <a href={`tel:${selected.phone.replace(/\D/g,'')}`} style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3,
                width: '100%', padding: '10px 0', borderRadius: 10,
                background: T.greenLight, border: `1.5px solid ${T.greenBorder}`,
                color: T.green, fontSize: 13, fontWeight: 700, textDecoration: 'none',
              }}>
                <div style={{ fontSize: 12, fontWeight: 800 }}>{selected.contact || selected.builder}</div>
                <div style={{ fontSize: 12 }}>📞 {selected.phone}</div>
              </a>
            </div>
          )}

          <div style={{ display: 'flex', gap: 6, marginBottom: 0 }}>
            <a href={`maps://maps.apple.com/?q=${encodeURIComponent(selected.address + ', ' + selected.city + ', OK')}&ll=${selected.lat},${selected.lng}`}
              target="_blank" rel="noopener noreferrer" style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                padding: '10px 0', borderRadius: 10,
                background: T.blueLight, border: `1.5px solid ${T.blueBorder}`,
                color: T.blue, fontSize: 13, fontWeight: 700, textDecoration: 'none',
              }}>
              📍 Maps
            </a>
            <button onClick={() => addToRoute(selected)} style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
              padding: '10px 0', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
              background: isInRoute ? T.blueLight : T.bg,
              border: isInRoute ? `1.5px solid ${T.blueBorder}` : `1px solid ${T.cardBorder}`,
              color: isInRoute ? T.blue : T.textSub,
              fontSize: 13, fontWeight: 700,
            }}>
              {isInRoute ? '✓ Added' : '＋ Route'}
            </button>
            <button onClick={() => { setSelectedPermit(selected); setShowVisitModal(true); }} style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
              padding: '10px 0', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
              background: T.blueLight, border: `1.5px solid ${T.blueBorder}`, color: T.blue,
              fontSize: 13, fontWeight: 700,
            }}>
              📝 Visit
            </button>
          </div>

          <details style={{ marginTop: 8, marginBottom: 8 }}>
            <summary style={{ fontSize: 12, color: T.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, cursor: 'pointer' }}>Notes</summary>
            <textarea
              value={noteText || notes[selected.id] || ''}
              onChange={e => setNoteText(e.target.value)}
              onBlur={e => saveNote(selected.id, e.target.value)}
              placeholder="Add a note…"
              rows={2}
              style={{
                width: '100%', marginTop: 6, padding: '8px 10px', borderRadius: 8,
                border: `1px solid ${T.cardBorder}`, background: T.bg,
                color: T.text, fontSize: 12, fontFamily: 'inherit', resize: 'none',
                outline: 'none', boxSizing: 'border-box',
              }}
            />
          </details>

          <details style={{ marginBottom: 8 }}>
            <summary style={{ fontSize: 12, color: T.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, cursor: 'pointer' }}>Status</summary>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              {STATUSES.map(s => {
                const active = statuses[selected.id] === s.key;
                return (
                  <button key={s.key} onClick={() => setStatus(selected.id, active ? null : s.key, selected)} style={{
                    padding: '6px 12px', borderRadius: 16, fontSize: 12, fontWeight: 700,
                    cursor: 'pointer', fontFamily: 'inherit',
                    background: active ? s.color : T.bg,
                    border: active ? `1.5px solid ${s.color}` : `1px solid ${T.cardBorder}`,
                    color: active ? '#fff' : T.textSub,
                    transition: 'all 0.15s',
                  }}>{s.label}</button>
                );
              })}
            </div>
          </details>
        </div>
      )}

      {/* ── Active Builder Filter Card ───────────────────────────────────────── */}
      {searchQuery.trim() && (() => {
        const activeBuilder = permits.find(p => (p.builder || '').toLowerCase() === searchQuery.toLowerCase());
        if (!activeBuilder) return null;
        return (
          <div style={{
            position: 'fixed',
            top: TOP_BAR_HEIGHT + 12,
            left: (panelOpen ? (sidebarExpanded ? SIDEBAR_WIDTH_EXPANDED : SIDEBAR_WIDTH_COLLAPSED) + 248 : (sidebarExpanded ? SIDEBAR_WIDTH_EXPANDED : SIDEBAR_WIDTH_COLLAPSED)) + 12,
            zIndex: 25,
            maxWidth: 280,
            background: 'rgba(10,10,15,0.9)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderLeft: '4px solid #00D47E',
            borderRadius: 12,
            padding: 14,
            touchAction: 'none',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 800, color: D.text }}>Filtering by</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#00D47E', marginTop: 4 }}>{activeBuilder.builder}</div>
              </div>
              <button onClick={() => setSearchQuery('')} style={{ background: 'none', border: 'none', fontSize: 20, color: D.textMuted, cursor: 'pointer', padding: 0 }} title="Clear filter">✕</button>
            </div>
            {activeBuilder.contact && (
              <div style={{ fontSize: 12, color: D.textSub, marginBottom: 6 }}><strong style={{ color: D.textMuted }}>Contact:</strong> {activeBuilder.contact}</div>
            )}
            {activeBuilder.phone && (
              <div style={{ fontSize: 12, color: '#00D47E', fontWeight: 600 }}>📞 {activeBuilder.phone}</div>
            )}
            <div style={{ fontSize: 11, color: D.textMuted, marginTop: 8 }}>
              Showing {filtered.length} permit{filtered.length !== 1 ? 's' : ''}
            </div>
          </div>
        );
      })()}

      {/* ── Permit List ──────────────────────────────────────────────────────── */}
      {showPermitList && (
        <PermitList
          permits={filtered}
          statuses={statuses}
          activeUser={activeUser}
          onClose={() => setShowPermitList(false)}
          onSelectPermit={(p) => { setShowPermitList(false); selectPermit(p); }}
        />
      )}

      {/* ── Team Full Page ───────────────────────────────────────────────────── */}
      {teamView && (
        <TeamPage
          activeUser={activeUser}
          onClose={() => setTeamView(false)}
          permits={permits}
          dailyRoutes={dailyRoutes}
          addToDailyRoute={addToDailyRoute}
          removeFromDailyRoute={removeFromDailyRoute}
          myRoute={routeList}
        />
      )}

      {/* ── Visit Modal ──────────────────────────────────────────────────────── */}
      {showVisitModal && selectedPermit && (
        <VisitModal
          permit={selectedPermit}
          salesman={activeUser}
          onClose={() => { setShowVisitModal(false); setSelectedPermit(null); }}
        />
      )}

      {/* ── Dashboard ────────────────────────────────────────────────────────── */}
      {showDashboard && (
        <Dashboard
          salesman={activeUser}
          permits={permits}
          onClose={() => { setShowDashboard(false); }}
          onSelectBuilder={handleSelectBuilder}
        />
      )}

      {/* ── Lead Hub ──────────────────────────────────────────────────────────── */}
      {showLeadHub && (
        <LeadHub onClose={() => setShowLeadHub(false)} />
      )}

      {/* ── Territory Toggle (floating map control) ─────────────────────────── */}
      {!selected && !showRoutePanel && (
        <div style={{
          position: 'fixed',
          top: TOP_BAR_HEIGHT + 12,
          right: 16,
          zIndex: 15,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          alignItems: 'flex-end',
          touchAction: 'none',
        }}>
          <button
            onClick={() => setShowTerritories(v => !v)}
            title="Toggle territory colors"
            style={{
              padding: '6px 12px',
              borderRadius: 8,
              fontSize: 11,
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: 'inherit',
              background: showTerritories ? 'rgba(0,212,126,0.15)' : 'rgba(10,10,15,0.85)',
              border: showTerritories ? '1.5px solid rgba(0,212,126,0.5)' : '1px solid rgba(255,255,255,0.12)',
              color: showTerritories ? '#00D47E' : 'rgba(240,240,245,0.7)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
              whiteSpace: 'nowrap',
              boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
            }}
          >
            {showTerritories ? '🗺 Territories ON' : '🗺 Territories'}
          </button>

          {/* Territory legend — shown when toggle is on */}
          {showTerritories && (
            <div style={{
              background: 'rgba(10,10,15,0.88)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 10,
              padding: '10px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              boxShadow: '0 2px 12px rgba(0,0,0,0.5)',
            }}>
              {[
                { name: 'Johnny', zone: 'Central Tulsa' },
                { name: 'Jordan', zone: 'East / SE' },
                { name: 'Skip',   zone: 'North / West' },
              ].map(({ name, zone }) => (
                <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{
                    width: 10, height: 10, borderRadius: '50%',
                    background: SALESMAN_COLORS[name],
                    border: '2px solid rgba(255,255,255,0.25)',
                    flexShrink: 0,
                  }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: SALESMAN_COLORS[name] }}>{name}</span>
                  <span style={{ fontSize: 10, color: 'rgba(240,240,245,0.45)' }}>{zone}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Mobile Bottom Tab Bar ────────────────────────────────────────────── */}
      <div
        className="ist-bottom-tabs"
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          height: 64,
          zIndex: 20,
          background: 'rgba(10,10,15,0.95)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          alignItems: 'stretch',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          touchAction: 'none',
        }}
      >
        {[
          { key: 'map',     icon: '🗺️', label: 'Map' },
          { key: 'filters', icon: '≡',  label: 'Filters' },
          { key: 'route',   icon: '📍', label: 'Route' },
          { key: 'intel',   icon: '📊', label: 'Intel' },
          { key: 'team',    icon: '👥', label: 'Team' },
          { key: 'leads',   icon: '🎯', label: 'Leads' },
        ].map(({ key, icon, label }) => {
          const isActive = activeNav === key;
          const showBadge = (key === 'route' && routeList.length > 0) || (key === 'leads' && newLeadsCount > 0);
          const tabBadgeCount = key === 'route' ? routeList.length : key === 'leads' ? newLeadsCount : 0;
          return (
            <button
              key={key}
              onClick={() => handleNavClick(key)}
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 2,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
                position: 'relative',
              }}
            >
              <span style={{ fontSize: 18, lineHeight: 1, color: isActive ? '#00D47E' : D.textSub }}>{icon}</span>
              <span style={{ fontSize: 10, fontWeight: isActive ? 700 : 500, color: isActive ? '#00D47E' : D.textMuted }}>{label}</span>
              {showBadge && (
                <span style={{
                  position: 'absolute', top: 4, right: '50%', marginRight: -18,
                  background: '#00D47E', color: '#0A0A0F',
                  fontSize: 9, fontWeight: 800, borderRadius: 8,
                  padding: '1px 5px', minWidth: 16, textAlign: 'center',
                }}>{tabBadgeCount}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Style helpers ─────────────────────────────────────────────────────────────
const filterBtn = (active) => ({
  padding: '5px 10px',
  borderRadius: 7,
  fontSize: 12,
  cursor: 'pointer',
  fontWeight: active ? 700 : 500,
  border: active ? `1.5px solid #00D47E` : `1px solid rgba(255,255,255,0.1)`,
  background: active ? 'rgba(0,212,126,0.12)' : 'rgba(255,255,255,0.05)',
  color: active ? '#00D47E' : 'rgba(240,240,245,0.6)',
  fontFamily: 'inherit',
  transition: 'all 0.15s',
});

const ghostBtn = {
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.12)',
  color: T.text,
  cursor: 'pointer',
  borderRadius: 8,
  padding: '6px 12px',
  fontSize: 13,
  fontFamily: 'inherit',
  backdropFilter: 'blur(10px)',
  transition: 'all 0.2s',
};

const darkGhostBtn = {
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.1)',
  color: 'rgba(240,240,245,0.6)',
  cursor: 'pointer',
  borderRadius: 8,
  padding: '6px 12px',
  fontSize: 13,
  fontFamily: 'inherit',
  transition: 'all 0.2s',
};
