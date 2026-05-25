'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { CITIES, PERMITS } from '../../lib/permits';

const MAP_STYLES = {
  // Public raster tiles so the permit map works even when Vercel has no Mapbox token.
  satellite: {
    version: 8,
    sources: {
      satellite: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        attribution: 'Tiles © Esri',
      },
    },
    layers: [{ id: 'satellite', type: 'raster', source: 'satellite' }],
  },
  streets: {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
  },
  dark: {
    version: 8,
    sources: {
      carto: {
        type: 'raster',
        tiles: ['https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors © CARTO',
      },
    },
    layers: [{ id: 'carto-dark', type: 'raster', source: 'carto' }],
  },
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
  const [permits, setPermits] = useState(() => PERMITS);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const [city, setCity] = useState('All');
  const [styleKey, setStyleKey] = useState('streets');
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
        const livePermits = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
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

  const mappedCount = geoJSON.features.length;

  const pinPositions = useMemo(() => {
    const mapped = filtered.filter(p => Number(p.lat) && Number(p.lng));
    if (!mapped.length) return [];
    const lats = mapped.map(p => Number(p.lat));
    const lngs = mapped.map(p => Number(p.lng));
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    return mapped.map(p => ({
      permit: p,
      left: 36 + ((Number(p.lng) - minLng) / Math.max(0.0001, maxLng - minLng)) * 58,
      top: 8 + (1 - ((Number(p.lat) - minLat) / Math.max(0.0001, maxLat - minLat))) * 84,
      score: permitScore(p),
    }));
  }, [filtered]);

  const stats = useMemo(() => {
    const totalValue = filtered.reduce((sum, p) => sum + (Number(p.value) || 0), 0);
    const custom = filtered.filter(p => !p.production).length;
    const highPulse = filtered.filter(p => permitScore(p) >= 70).length;
    return { totalValue, custom, highPulse };
  }, [filtered]);

  useEffect(() => {
    if (mapRef.current || !mapContainer.current) return;
    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: MAP_STYLES[styleKey],
      center: [-95.86, 36.11],
      zoom: 9.75,
      pitch: 38,
      bearing: -8,
      antialias: true,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');

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
      map.on('mouseenter', 'permit-points', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'permit-points', () => { map.getCanvas().style.cursor = ''; });
      map.on('click', 'permit-points', e => {
        const props = e.features?.[0]?.properties || null;
        if (!props) return;
        setSelected(props);
        map.easeTo({ center: e.features[0].geometry.coordinates, zoom: Math.max(map.getZoom(), 12), duration: 500 });
      });

      const coords = geoJSON.features.map(f => f.geometry.coordinates);
      if (coords.length) {
        const bounds = coords.reduce((b, coord) => b.extend(coord), new maplibregl.LngLatBounds(coords[0], coords[0]));
        map.fitBounds(bounds, { padding: { top: 70, bottom: 70, left: 470, right: 70 }, maxZoom: 10.6, duration: 0 });
      }
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
    const bounds = coords.reduce((b, coord) => b.extend(coord), new maplibregl.LngLatBounds(coords[0], coords[0]));
    mapRef.current.fitBounds(bounds, { padding: 80, maxZoom: 13, duration: 700 });
  };

  return (
    <main style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: PALETTE.bg, color: PALETTE.text, fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif' }}>
      <div ref={mapContainer} style={{ position: 'absolute', inset: 0, zIndex: 0 }} />
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none', opacity: styleKey === 'satellite' ? 0.16 : 0.24, backgroundColor: styleKey === 'dark' ? '#06130f' : '#10251f', backgroundImage: 'linear-gradient(32deg, transparent 0 47%, rgba(255,255,255,0.20) 48% 50%, transparent 51% 100%), linear-gradient(118deg, transparent 0 46%, rgba(255,255,255,0.12) 47% 49%, transparent 50% 100%), linear-gradient(rgba(255,255,255,0.10) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.10) 1px, transparent 1px)', backgroundSize: '520px 520px, 430px 430px, 84px 84px, 84px 84px' }} />
      <div aria-label="Permit pin overlay" style={{ position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none' }}>
        {pinPositions.map(({ permit, left, top, score }) => (
          <button key={`pin-${permit.id}`} title={`${permit.builder || permit.owner || 'Permit'} — ${permit.address || ''}`} onClick={() => setSelected(permit)} style={{ position: 'absolute', left: `${left}%`, top: `${top}%`, transform: 'translate(-50%, -50%)', width: score >= 75 ? 16 : 12, height: score >= 75 ? 16 : 12, borderRadius: 999, border: '2px solid #fff', background: scoreColor(score), boxShadow: `0 0 0 6px ${scoreColor(score)}33, 0 0 22px ${scoreColor(score)}`, padding: 0, pointerEvents: 'auto', cursor: 'pointer' }} />
        ))}
      </div>
      <div style={{ position: 'absolute', inset: 0, zIndex: 3, pointerEvents: 'none', background: 'radial-gradient(circle at 12% 10%, rgba(41,209,125,0.12), transparent 24%), linear-gradient(90deg, rgba(6,19,15,0.78) 0%, rgba(6,19,15,0.28) 31%, rgba(6,19,15,0.00) 62%)' }} />

      <section style={{ position: 'absolute', top: 18, left: 18, bottom: 18, width: 'min(430px, calc(100vw - 36px))', zIndex: 4, display: 'flex', flexDirection: 'column', gap: 14, pointerEvents: 'auto' }}>
        <div style={{ border: `1px solid ${PALETTE.borderStrong}`, background: PALETTE.panel, borderRadius: 30, padding: 22, boxShadow: '0 24px 70px rgba(0,0,0,0.35)', backdropFilter: 'blur(18px)' }}>
          <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center', padding: '6px 10px', borderRadius: 999, background: 'rgba(41,209,125,0.12)', border: `1px solid ${PALETTE.borderStrong}`, color: PALETTE.green2, fontSize: 11, fontWeight: 900, letterSpacing: 1.3, textTransform: 'uppercase' }}>
            Live permit intelligence
          </div>
          <h1 style={{ margin: '14px 0 8px', fontSize: 40, lineHeight: 0.95, letterSpacing: -1.8 }}>Green Country Permits</h1>
          <p style={{ margin: 0, color: PALETTE.muted, lineHeight: 1.45, fontSize: 14 }}>A clean permit discovery dashboard for northeast Oklahoma — built around projects, locations, values, and timing.</p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginTop: 18 }}>
            <Stat label="Total permits" value={filtered.length} />
            <Stat label="Mapped pins" value={mappedCount} accent={PALETTE.blue} />
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
              <option value="streets">Streets</option>
              <option value="satellite">Satellite</option>
              <option value="dark">Dark</option>
            </select>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => setCustomOnly(v => !v)} style={chipStyle(customOnly)}>Custom / independent</button>
            <button onClick={() => setMinScore(v => v >= 70 ? 0 : 70)} style={chipStyle(minScore >= 70)}>High-pulse only</button>
            <button onClick={fitFiltered} style={chipStyle(false)}>Fit map</button>
          </div>

          {months.length > 0 && <div style={{ color: PALETTE.faint, fontSize: 12 }}>Months in data: {months.join(', ')} · {mappedCount} mapped / {filtered.length} total permits</div>}
          {loading && <div style={{ color: PALETTE.green2, fontSize: 13, fontWeight: 800 }}>Loading permits…</div>}
        </div>

        <div style={{ border: `1px solid ${PALETTE.border}`, background: PALETTE.panel, borderRadius: 26, padding: 12, backdropFilter: 'blur(18px)', overflow: 'auto', minHeight: 0, flex: 1 }}>
          <div style={{ color: PALETTE.faint, fontSize: 11, fontWeight: 900, letterSpacing: 1.2, textTransform: 'uppercase', margin: '2px 4px 10px' }}>
            Permit list · {filtered.length} total
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            {filtered.slice(0, 140).map(permit => {
              const isMapped = Number(permit.lat) && Number(permit.lng);
              return (
                <button key={permit.id} onClick={() => { if (isMapped) { setSelected(permit); mapRef.current?.easeTo({ center: [Number(permit.lng), Number(permit.lat)], zoom: 12, duration: 500 }); } }} style={{ textAlign: 'left', border: `1px solid ${isMapped ? PALETTE.borderStrong : PALETTE.border}`, background: isMapped ? 'rgba(41,209,125,0.10)' : 'rgba(255,255,255,0.05)', color: PALETTE.text, borderRadius: 16, padding: '10px 11px', cursor: isMapped ? 'pointer' : 'default', font: 'inherit' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                    <strong style={{ fontSize: 13 }}>{permit.builder || permit.owner || 'Unknown permit holder'}</strong>
                    <span style={{ color: isMapped ? PALETTE.green2 : PALETTE.faint, fontSize: 10, fontWeight: 900, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{isMapped ? 'Mapped' : 'Needs geocode'}</span>
                  </div>
                  <div style={{ marginTop: 3, color: PALETTE.muted, fontSize: 12 }}>{permit.address}{permit.city ? ` · ${permit.city}` : ''}</div>
                  <div style={{ marginTop: 3, color: PALETTE.faint, fontSize: 11 }}>{money(permit.value)} · {permit.week || 'No week'}</div>
                </button>
              );
            })}
          </div>
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
