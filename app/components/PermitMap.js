'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { CITIES, PERMITS } from '../../lib/permits';

const MAP_STYLES = {
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
  streets: 'mapbox://styles/mapbox/streets-v12',
  dark: 'mapbox://styles/mapbox/dark-v11',
};

const PALETTE = {
  bg: '#06130f',
  panel: 'rgba(6, 19, 15, 0.88)',
  panelSoft: 'rgba(255, 255, 255, 0.08)',
  border: 'rgba(205, 255, 229, 0.16)',
  borderStrong: 'rgba(64, 214, 137, 0.38)',
  green: '#29d17d',
  green2: '#7be3a9',
  gold: '#ffd166',
  blue: '#73c9ff',
  text: '#f4fff8',
  muted: 'rgba(244, 255, 248, 0.68)',
  faint: 'rgba(244, 255, 248, 0.45)',
};

function money(value) {
  const n = Number(value) || 0;
  if (!n) return 'Value TBD';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

function number(value) {
  const n = Number(value) || 0;
  return n ? n.toLocaleString() : '—';
}

function monthFromWeek(week) {
  const m = parseInt(String(week || '').match(/(\d{1,2})[\/\-]/)?.[1] || '0', 10);
  if (!m || m < 1 || m > 12) return null;
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1];
}

function permitScore(permit) {
  const valueScore = Math.min(45, (Number(permit.value) || 0) / 25000);
  const sizeScore = Math.min(35, (Number(permit.sqft) || 0) / 140);
  const freshnessScore = permit.week ? 12 : 0;
  const customScore = permit.production ? 0 : 8;
  return Math.round(Math.min(100, valueScore + sizeScore + freshnessScore + customScore));
}

function scoreColor(score) {
  if (score >= 75) return '#29d17d';
  if (score >= 50) return '#ffd166';
  return '#73c9ff';
}

function buildGeoJSON(permits) {
  return {
    type: 'FeatureCollection',
    features: permits
      .filter(p => Number(p.lat) && Number(p.lng))
      .map(p => {
        const score = permitScore(p);
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [Number(p.lng), Number(p.lat)] },
          properties: {
            ...p,
            score,
            color: scoreColor(score),
            label: p.builder || p.owner || 'Permit',
          },
        };
      }),
  };
}

function Stat({ label, value, accent = PALETTE.green }) {
  return (
    <div style={{ padding: 14, borderRadius: 18, background: PALETTE.panelSoft, border: `1px solid ${PALETTE.border}` }}>
      <div style={{ fontSize: 22, fontWeight: 900, color: accent, letterSpacing: -0.5 }}>{value}</div>
      <div style={{ marginTop: 2, fontSize: 11, color: PALETTE.faint, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
    </div>
  );
}

function PermitCard({ permit, onClose }) {
  if (!permit) return null;
  const score = permitScore(permit);
  return (
    <div style={{ position: 'absolute', right: 18, bottom: 18, width: 'min(430px, calc(100vw - 36px))', zIndex: 5, color: PALETTE.text }}>
      <div style={{ borderRadius: 28, background: 'rgba(6, 19, 15, 0.94)', border: `1px solid ${PALETTE.borderStrong}`, boxShadow: '0 24px 80px rgba(0,0,0,0.45)', backdropFilter: 'blur(18px)', overflow: 'hidden' }}>
        <div style={{ padding: 20, background: 'linear-gradient(135deg, rgba(41,209,125,0.18), rgba(115,201,255,0.08))' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, color: PALETTE.green2, textTransform: 'uppercase', letterSpacing: 1.4, fontWeight: 800 }}>Permit Signal</div>
              <div style={{ marginTop: 5, fontSize: 23, lineHeight: 1.05, fontWeight: 950 }}>{permit.builder || permit.owner || 'Unknown permit holder'}</div>
            </div>
            <button onClick={onClose} aria-label="Close permit" style={{ width: 34, height: 34, borderRadius: 17, border: `1px solid ${PALETTE.border}`, color: PALETTE.text, background: 'rgba(255,255,255,0.08)', cursor: 'pointer', fontSize: 18 }}>×</button>
          </div>
          <div style={{ marginTop: 12, color: PALETTE.muted, fontSize: 14 }}>{permit.address}{permit.city ? ` · ${permit.city}` : ''}</div>
        </div>

        <div style={{ padding: 18, display: 'grid', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            <Stat label="Project" value={money(permit.value)} accent={PALETTE.gold} />
            <Stat label="Sq Ft" value={number(permit.sqft)} accent={PALETTE.blue} />
            <Stat label="Pulse" value={score} accent={scoreColor(score)} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 13 }}>
            <div style={{ padding: 12, borderRadius: 16, background: PALETTE.panelSoft }}><b>Week:</b> {permit.week || '—'}</div>
            <div style={{ padding: 12, borderRadius: 16, background: PALETTE.panelSoft }}><b>Type:</b> {permit.production ? 'Production builder' : 'Custom / independent'}</div>
            <div style={{ padding: 12, borderRadius: 16, background: PALETTE.panelSoft }}><b>Subdivision:</b> {permit.subdivision || '—'}</div>
            <div style={{ padding: 12, borderRadius: 16, background: PALETTE.panelSoft }}><b>Contact:</b> {permit.contact || permit.phone || '—'}</div>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {permit.phone && <a href={`tel:${permit.phone}`} style={buttonStyle(PALETTE.green)}>Call</a>}
            <a target="_blank" rel="noreferrer" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${permit.address || ''} ${permit.city || ''} OK`)}`} style={buttonStyle(PALETTE.blue)}>Open Map</a>
          </div>
        </div>
      </div>
    </div>
  );
}

function buttonStyle(color) {
  return {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: 38, padding: '0 15px', borderRadius: 999,
    color: '#04110c', background: color, textDecoration: 'none', fontWeight: 900, border: 'none', cursor: 'pointer', fontSize: 13,
  };
}

export default function PermitMap() {
  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const [permits, setPermits] = useState(() => PERMITS.filter(p => Number(p.lat) && Number(p.lng)));
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const [city, setCity] = useState('All');
  const [styleKey, setStyleKey] = useState('satellite');
  const [query, setQuery] = useState('');
  const [customOnly, setCustomOnly] = useState(false);
  const [minScore, setMinScore] = useState(0);

  useEffect(() => {
    if (!db) return;
    let alive = true;
    setLoading(true);
    getDocs(collection(db, 'permits'))
      .then(snapshot => {
        if (!alive) return;
        const livePermits = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).filter(p => Number(p.lat) && Number(p.lng));
        if (livePermits.length) setPermits(livePermits);
      })
      .catch(error => {
        console.warn('Using bundled permit sample because live permit data is unavailable:', error);
      })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  const months = useMemo(() => {
    const found = new Set(permits.map(p => monthFromWeek(p.week)).filter(Boolean));
    return Array.from(found);
  }, [permits]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return permits.filter(p => {
      if (city !== 'All' && p.city !== city) return false;
      if (customOnly && p.production) return false;
      if (permitScore(p) < minScore) return false;
      if (q && ![p.builder, p.owner, p.address, p.city, p.subdivision, p.contact].some(v => String(v || '').toLowerCase().includes(q))) return false;
      return true;
    });
  }, [permits, city, customOnly, minScore, query]);

  const geoJSON = useMemo(() => buildGeoJSON(filtered), [filtered]);

  const stats = useMemo(() => {
    const totalValue = filtered.reduce((sum, p) => sum + (Number(p.value) || 0), 0);
    const custom = filtered.filter(p => !p.production).length;
    const highPulse = filtered.filter(p => permitScore(p) >= 70).length;
    return { totalValue, custom, highPulse };
  }, [filtered]);

  useEffect(() => {
    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!token || mapRef.current || !mapContainer.current) return;
    mapboxgl.accessToken = token;
    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: MAP_STYLES[styleKey],
      center: [-95.86, 36.11],
      zoom: 9.75,
      pitch: 38,
      bearing: -8,
      antialias: true,
    });
    mapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-right');

    map.on('load', () => {
      map.addSource('permits', { type: 'geojson', data: geoJSON });
      map.addLayer({
        id: 'permit-halos',
        type: 'circle',
        source: 'permits',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'score'], 0, 14, 100, 34],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.16,
          'circle-blur': 0.45,
        },
      });
      map.addLayer({
        id: 'permit-points',
        type: 'circle',
        source: 'permits',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'score'], 0, 5, 100, 11],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.4,
          'circle-opacity': 0.94,
        },
      });
      map.addLayer({
        id: 'permit-labels',
        type: 'symbol',
        source: 'permits',
        minzoom: 11.2,
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 11,
          'text-offset': [0, 1.2],
          'text-anchor': 'top',
        },
        paint: {
          'text-color': '#f4fff8',
          'text-halo-color': '#06130f',
          'text-halo-width': 1.6,
        },
      });
      map.on('mouseenter', 'permit-points', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'permit-points', () => { map.getCanvas().style.cursor = ''; });
      map.on('click', 'permit-points', e => {
        const props = e.features?.[0]?.properties || null;
        if (!props) return;
        setSelected(props);
        map.easeTo({ center: e.features[0].geometry.coordinates, zoom: Math.max(map.getZoom(), 12), duration: 500 });
      });
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // initialize once; data/style updates happen below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (map.isStyleLoaded() && map.getSource('permits')) {
      map.getSource('permits').setData(geoJSON);
    } else {
      map.once('idle', () => map.getSource('permits')?.setData(geoJSON));
    }
  }, [geoJSON]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !MAP_STYLES[styleKey]) return;
    map.setStyle(MAP_STYLES[styleKey]);
    map.once('style.load', () => {
      if (!map.getSource('permits')) {
        map.addSource('permits', { type: 'geojson', data: geoJSON });
        map.addLayer({ id: 'permit-halos', type: 'circle', source: 'permits', paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'score'], 0, 14, 100, 34], 'circle-color': ['get', 'color'], 'circle-opacity': 0.16, 'circle-blur': 0.45 } });
        map.addLayer({ id: 'permit-points', type: 'circle', source: 'permits', paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'score'], 0, 5, 100, 11], 'circle-color': ['get', 'color'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.4, 'circle-opacity': 0.94 } });
      }
    });
  }, [styleKey]);

  const fitFiltered = () => {
    const coords = geoJSON.features.map(f => f.geometry.coordinates);
    if (!coords.length || !mapRef.current) return;
    const bounds = coords.reduce((b, coord) => b.extend(coord), new mapboxgl.LngLatBounds(coords[0], coords[0]));
    mapRef.current.fitBounds(bounds, { padding: 80, maxZoom: 13, duration: 700 });
  };

  return (
    <main style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: PALETTE.bg, color: PALETTE.text, fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif' }}>
      <div ref={mapContainer} style={{ position: 'absolute', inset: 0 }} />
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'radial-gradient(circle at 12% 10%, rgba(41,209,125,0.20), transparent 28%), linear-gradient(90deg, rgba(6,19,15,0.88) 0%, rgba(6,19,15,0.48) 34%, rgba(6,19,15,0.05) 70%)' }} />

      <section style={{ position: 'absolute', top: 18, left: 18, bottom: 18, width: 'min(430px, calc(100vw - 36px))', zIndex: 4, display: 'flex', flexDirection: 'column', gap: 14, pointerEvents: 'auto' }}>
        <div style={{ border: `1px solid ${PALETTE.borderStrong}`, background: PALETTE.panel, borderRadius: 30, padding: 22, boxShadow: '0 24px 70px rgba(0,0,0,0.35)', backdropFilter: 'blur(18px)' }}>
          <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center', padding: '6px 10px', borderRadius: 999, background: 'rgba(41,209,125,0.12)', border: `1px solid ${PALETTE.borderStrong}`, color: PALETTE.green2, fontSize: 11, fontWeight: 900, letterSpacing: 1.3, textTransform: 'uppercase' }}>
            Live permit intelligence
          </div>
          <h1 style={{ margin: '14px 0 8px', fontSize: 40, lineHeight: 0.95, letterSpacing: -1.8 }}>Green Country Permits</h1>
          <p style={{ margin: 0, color: PALETTE.muted, lineHeight: 1.45, fontSize: 14 }}>A clean permit discovery dashboard for northeast Oklahoma — built around projects, locations, values, and timing.</p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginTop: 18 }}>
            <Stat label="Permits" value={filtered.length} />
            <Stat label="Custom" value={stats.custom} accent={PALETTE.blue} />
            <Stat label="High Pulse" value={stats.highPulse} accent={PALETTE.gold} />
          </div>
          <div style={{ marginTop: 10 }}>
            <Stat label="Visible Project Value" value={money(stats.totalValue)} accent={PALETTE.green2} />
          </div>
        </div>

        <div style={{ border: `1px solid ${PALETTE.border}`, background: PALETTE.panel, borderRadius: 26, padding: 16, backdropFilter: 'blur(18px)', display: 'grid', gap: 12 }}>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search builder, address, city, subdivision…" style={{ width: '100%', boxSizing: 'border-box', height: 46, borderRadius: 16, border: `1px solid ${PALETTE.border}`, background: 'rgba(255,255,255,0.08)', color: PALETTE.text, padding: '0 14px', outline: 'none', fontSize: 14 }} />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <select value={city} onChange={e => setCity(e.target.value)} style={selectStyle()}>
              <option value="All">All cities</option>
              {CITIES.filter(c => c !== 'All').map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={styleKey} onChange={e => setStyleKey(e.target.value)} style={selectStyle()}>
              <option value="satellite">Satellite</option>
              <option value="streets">Streets</option>
              <option value="dark">Dark</option>
            </select>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => setCustomOnly(v => !v)} style={chipStyle(customOnly)}>Custom / independent</button>
            <button onClick={() => setMinScore(v => v >= 70 ? 0 : 70)} style={chipStyle(minScore >= 70)}>High-pulse only</button>
            <button onClick={fitFiltered} style={chipStyle(false)}>Fit map</button>
          </div>

          {months.length > 0 && <div style={{ color: PALETTE.faint, fontSize: 12 }}>Months in data: {months.join(', ')}</div>}
          {loading && <div style={{ color: PALETTE.green2, fontSize: 13, fontWeight: 800 }}>Loading permits…</div>}
        </div>
      </section>

      <div style={{ position: 'absolute', right: 18, top: 18, zIndex: 4, border: `1px solid ${PALETTE.border}`, background: PALETTE.panel, color: PALETTE.muted, borderRadius: 999, padding: '10px 14px', fontSize: 12, fontWeight: 800, backdropFilter: 'blur(18px)' }}>
        Public permit dashboard · Permit data only
      </div>

      <PermitCard permit={selected} onClose={() => setSelected(null)} />
    </main>
  );
}

function selectStyle() {
  return { height: 44, borderRadius: 15, border: `1px solid ${PALETTE.border}`, background: 'rgba(255,255,255,0.08)', color: PALETTE.text, padding: '0 12px', outline: 'none', fontSize: 13, fontWeight: 800 };
}

function chipStyle(active) {
  return { border: `1px solid ${active ? PALETTE.green : PALETTE.border}`, background: active ? 'rgba(41,209,125,0.18)' : 'rgba(255,255,255,0.07)', color: active ? PALETTE.green2 : PALETTE.text, borderRadius: 999, minHeight: 36, padding: '0 13px', fontSize: 12, fontWeight: 900, cursor: 'pointer' };
}
