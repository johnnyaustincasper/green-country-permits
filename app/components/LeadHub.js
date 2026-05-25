'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { db } from '../../lib/firebase';
import { collection, onSnapshot, doc, updateDoc } from 'firebase/firestore';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function timeAgo(ts) {
  if (!ts) return '';
  const ms = ts?.toMillis ? ts.toMillis() : typeof ts === 'number' ? ts : new Date(ts).getTime();
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function isNew24h(ts) {
  if (!ts) return false;
  const ms = ts?.toMillis ? ts.toMillis() : typeof ts === 'number' ? ts : new Date(ts).getTime();
  return Date.now() - ms < 86400000;
}

function getLeadTs(lead) {
  if (lead.processedAt?.toMillis) return lead.processedAt.toMillis();
  if (typeof lead.processedAt === 'number') return lead.processedAt;
  if (lead.processedAt) return new Date(lead.processedAt).getTime();
  return 0;
}

function scoreColor(s) {
  if (!s) return 'rgba(255,255,255,0.2)';
  if (s <= 5) return 'rgba(255,255,255,0.2)';
  if (s <= 7) return '#f59e0b';
  if (s <= 9) return '#f97316';
  return '#ef4444';
}

// ─── CRM Stage Config ─────────────────────────────────────────────────────────
const STAGES = [
  { key: 'new',       label: 'New',       color: '#3b82f6' },
  { key: 'contacted', label: 'Contacted', color: '#f59e0b' },
  { key: 'quoted',    label: 'Quoted',    color: '#f97316' },
  { key: 'closed',    label: 'Closed',    color: '#10b981' },
  { key: 'dead',      label: 'Dead',      color: '#6b7280' },
];

function stageColor(s) {
  const found = STAGES.find(st => st.key === s);
  return found ? found.color : '#3b82f6';
}

function statusColor(s) {
  return stageColor(s);
}

function formatPrice(p) {
  if (!p) return 'N/A';
  return '$' + Number(p).toLocaleString();
}

function isPriorityLead(lead) {
  const email = lead.agentEmail;
  const phone = lead.agentPhone;
  const hasEmail = email && email !== 'N/A' && email.trim() !== '';
  const hasPhone918 = phone && phone !== 'N/A' && phone.trim() !== '' && phone.includes('918');
  return hasEmail || hasPhone918;
}

// ─── Count-up Hook ────────────────────────────────────────────────────────────
function useCountUp(target, duration = 1200) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    if (!target) { setVal(0); return; }
    let start = null;
    const from = 0;
    const step = (ts) => {
      if (!start) start = ts;
      const prog = Math.min((ts - start) / duration, 1);
      const ease = 1 - Math.pow(1 - prog, 3);
      setVal(Math.round(from + (target - from) * ease));
      if (prog < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, [target, duration]);
  return val;
}

// ─── Score Ring ───────────────────────────────────────────────────────────────
function ScoreRing({ score, size = 48 }) {
  const r = (size - 6) / 2;
  const circ = 2 * Math.PI * r;
  const fill = score ? (score / 10) * circ : 0;
  const color = scoreColor(score);
  const [animated, setAnimated] = useState(false);
  useEffect(() => { const t = setTimeout(() => setAnimated(true), 50); return () => clearTimeout(t); }, []);
  return (
    <svg width={size} height={size} style={{ flexShrink: 0 }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={3} />
      <circle
        cx={size/2} cy={size/2} r={r}
        fill="none"
        stroke={color}
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={animated ? circ - fill : circ}
        transform={`rotate(-90 ${size/2} ${size/2})`}
        style={{ transition: 'stroke-dashoffset 0.8s ease' }}
      />
      <text x={size/2} y={size/2} textAnchor="middle" dominantBaseline="central"
        style={{ fill: color, fontSize: size === 48 ? 13 : 16, fontWeight: 800, fontFamily: 'Inter, sans-serif' }}>
        {score || '?'}
      </text>
    </svg>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function Toast({ message, onDone }) {
  useEffect(() => { const t = setTimeout(onDone, 2500); return () => clearTimeout(t); }, [onDone]);
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      style={{
        position: 'fixed', bottom: 32, right: 32, zIndex: 9999,
        background: 'rgba(10,10,15,0.97)', border: '1px solid rgba(0,212,126,0.3)',
        borderRadius: 12, padding: '12px 20px',
        color: '#F0F0F5', fontSize: 14, fontWeight: 500,
        backdropFilter: 'blur(20px)', boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        fontFamily: 'Inter, sans-serif',
      }}
    >
      {message}
    </motion.div>
  );
}

// ─── Lead Card ────────────────────────────────────────────────────────────────
function LeadCard({ lead, onClick, isNew: flashNew, onStageChange }) {
  const isFB = lead.source === 'FB';
  const accentColor = isFB ? '#f97316' : '#8b5cf6';
  const ts = getLeadTs(lead);
  const isNewToday = isNew24h({ toMillis: () => ts });
  const [flash, setFlash] = useState(flashNew);
  const priority = isPriorityLead(lead);

  useEffect(() => {
    if (flash) { const t = setTimeout(() => setFlash(false), 600); return () => clearTimeout(t); }
  }, [flash]);

  return (
    <motion.div
      onClick={() => onClick(lead)}
      whileHover={{ y: -2 }}
      style={{
        display: 'flex', alignItems: 'stretch', cursor: 'pointer',
        position: 'relative',
        background: flash ? 'rgba(0,212,126,0.08)' : 'rgba(255,255,255,0.04)',
        border: priority ? '2px solid #00D47E' : (flash ? '1px solid rgba(0,212,126,0.5)' : '1px solid rgba(255,255,255,0.07)'),
        borderRadius: 12, overflow: 'hidden', marginBottom: 8,
        transition: 'all 150ms ease',
        animation: priority ? 'priorityPulse 2s ease-in-out infinite' : (flash ? undefined : undefined),
        boxShadow: flash && !priority ? '0 0 12px rgba(0,212,126,0.15)' : undefined,
      }}
    >
      {/* Priority badge */}
      {priority && (
        <div style={{
          position: 'absolute', top: 6, right: 56,
          fontSize: 9, fontWeight: 800, letterSpacing: '0.08em',
          color: '#00D47E', background: 'rgba(0,212,126,0.12)',
          border: '1px solid rgba(0,212,126,0.35)',
          borderRadius: 4, padding: '2px 6px',
          zIndex: 2, pointerEvents: 'none',
        }}>
          ⚡ PRIORITY
        </div>
      )}

      {/* Left accent bar */}
      <div style={{ width: 3, background: accentColor, flexShrink: 0 }} />

      {/* Content */}
      <div style={{ flex: 1, padding: '12px 14px', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            {/* Pulsing dot for new 24h leads */}
            {isNewToday && lead.status === 'new' && (
              <span style={{
                width: 6, height: 6, borderRadius: '50%', background: '#00D47E',
                flexShrink: 0, animation: 'pulseGreen 2s infinite',
              }} />
            )}
            <span style={{
              fontSize: 14, fontWeight: 700, color: '#F0F0F5',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {isFB ? (lead.group || 'Facebook Lead') : (lead.address || 'Redfin Lead')}
            </span>
          </div>
          {/* Source badge */}
          <span style={{
            fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
            padding: '2px 7px', borderRadius: 4, flexShrink: 0,
            background: isFB ? 'rgba(249,115,22,0.15)' : 'rgba(139,92,246,0.15)',
            color: accentColor, border: `1px solid ${accentColor}33`,
          }}>
            {isFB ? 'FACEBOOK' : 'REAL ESTATE'}
          </span>
        </div>

        {/* Subline */}
        <div style={{ fontSize: 12, color: 'rgba(240,240,245,0.5)', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {isFB
            ? <>
                {lead.phone && <span style={{ color: '#00D47E', fontWeight: 700, marginRight: 6 }}>📞 {lead.phone}</span>}
                {(lead.description || lead.text || '').substring(0, lead.phone ? 50 : 80)}
                {(lead.description || lead.text || '').length > (lead.phone ? 50 : 80) ? '…' : ''}
              </>
            : `${lead.yearBuilt || '?'} · ${lead.sqft ? lead.sqft.toLocaleString() : '?'} sqft · ${formatPrice(lead.price)}`
          }
        </div>
        {!isFB && lead.agentName && (
          <div style={{ fontSize: 11, color: 'rgba(240,240,245,0.35)', marginBottom: 6 }}>👤 {lead.agentName}</div>
        )}

        {/* Bottom row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <StatusPill status={lead.status} />
          <span style={{ fontSize: 11, color: 'rgba(240,240,245,0.3)', marginLeft: 'auto' }}>{timeAgo(lead.processedAt)}</span>
        </div>

        {/* Stage picker */}
        <StagePicker
          current={lead.status || 'new'}
          onChange={(stage) => onStageChange && onStageChange(lead, stage)}
        />
      </div>

      {/* Score ring */}
      <div style={{ display: 'flex', alignItems: 'center', paddingRight: 14 }}>
        <ScoreRing score={lead.score} size={44} />
      </div>
    </motion.div>
  );
}

// ─── Status Pill ──────────────────────────────────────────────────────────────
function StatusPill({ status }) {
  const color = statusColor(status || 'new');
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
      padding: '2px 8px', borderRadius: 20,
      background: `${color}20`, color,
      border: `1px solid ${color}40`,
      textTransform: 'uppercase',
    }}>
      {status || 'new'}
    </span>
  );
}

// ─── Stage Picker Strip ───────────────────────────────────────────────────────
function StagePicker({ current, onChange }) {
  return (
    <div
      onClick={e => e.stopPropagation()}
      style={{ display: 'flex', gap: 4, flexWrap: 'nowrap', marginTop: 8 }}
    >
      {STAGES.map(st => {
        const active = (current || 'new') === st.key;
        return (
          <button
            key={st.key}
            onClick={() => !active && onChange(st.key)}
            style={{
              flex: 1,
              padding: '3px 0',
              borderRadius: 6,
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.05em',
              cursor: active ? 'default' : 'pointer',
              fontFamily: 'Inter, sans-serif',
              border: `1px solid ${active ? st.color : st.color + '40'}`,
              background: active ? `${st.color}30` : 'transparent',
              color: active ? st.color : `${st.color}70`,
              transition: 'all 120ms ease',
              textTransform: 'uppercase',
              whiteSpace: 'nowrap',
            }}
          >
            {st.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Progress Bar ─────────────────────────────────────────────────────────────
function ProgressBar({ label, value, max = 100, color = '#00D47E' }) {
  const [animated, setAnimated] = useState(false);
  useEffect(() => { const t = setTimeout(() => setAnimated(true), 100); return () => clearTimeout(t); }, []);
  const pct = max ? (value / max) * 100 : 0;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 10, color: 'rgba(240,240,245,0.4)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{label}</span>
        <span style={{ fontSize: 10, color, fontWeight: 700 }}>{Math.round(pct)}%</span>
      </div>
      <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{
          height: '100%', borderRadius: 2, background: color,
          width: animated ? `${pct}%` : '0%',
          transition: 'width 0.8s ease',
        }} />
      </div>
    </div>
  );
}

// ─── Quote Row ────────────────────────────────────────────────────────────────
function QuoteRow({ label, amount, psoRebate, maxAmount, color = '#00D47E' }) {
  const [animated, setAnimated] = useState(false);
  useEffect(() => { const t = setTimeout(() => setAnimated(true), 100); return () => clearTimeout(t); }, []);
  const pct = maxAmount ? (amount / maxAmount) * 100 : 0;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 11, color: 'rgba(240,240,245,0.55)', fontWeight: 600 }}>{label}</span>
        <div style={{ textAlign: 'right' }}>
          <span style={{ fontSize: 13, color, fontWeight: 800 }}>${amount.toLocaleString()}</span>
          {psoRebate && <span style={{ fontSize: 10, color: '#00D47E', marginLeft: 6 }}>PSO eligible</span>}
        </div>
      </div>
      <div style={{ height: 5, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{
          height: '100%', borderRadius: 3, background: `linear-gradient(90deg, #00D47E, ${color})`,
          width: animated ? `${pct}%` : '0%', transition: 'width 0.8s ease',
        }} />
      </div>
    </div>
  );
}

// ─── Expandable FB Post Text ──────────────────────────────────────────────────
function FBPostText({ text }) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return <div style={{ fontSize: 13, color: 'rgba(240,240,245,0.45)' }}>No text available</div>;
  const preview = text.substring(0, 200);
  const hasMore = text.length > 200;
  return (
    <div style={{
      background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)',
      borderRadius: 10, padding: '12px 14px', fontSize: 13,
      color: 'rgba(240,240,245,0.8)', lineHeight: 1.6,
    }}>
      <span style={{ whiteSpace: 'pre-wrap' }}>
        {expanded ? text : preview}
        {!expanded && hasMore && '…'}
      </span>
      {hasMore && (
        <button
          onClick={() => setExpanded(e => !e)}
          style={{
            display: 'block', marginTop: 8, background: 'none', border: 'none',
            color: '#00D47E', fontSize: 12, fontWeight: 700, cursor: 'pointer',
            fontFamily: 'inherit', padding: 0,
          }}
        >
          {expanded ? '▲ Show less' : '▼ Show more'}
        </button>
      )}
    </div>
  );
}

// ─── Detail Slide-Over ────────────────────────────────────────────────────────
function LeadDetail({ lead, onClose, onStatusChange }) {
  const [notes, setNotes] = useState(lead?.notes || '');
  const isFB = lead?.source === 'FB';
  const collName = isFB ? 'fbLeads' : 'reLeads';
  const docId = isFB ? lead.id : lead.address;

  useEffect(() => { setNotes(lead?.notes || ''); }, [lead]);

  const saveNotes = async () => {
    if (!lead) return;
    try {
      await updateDoc(doc(db, collName, docId), { notes });
    } catch (e) { console.error('saveNotes:', e); }
  };

  // Quote calc for RE
  const sqft = lead?.sqft || 0;
  const pso = sqft > 1000;
  const q8 = sqft * 0.80;
  const q10 = sqft * 0.90;
  const q12 = sqft * 1.05;
  const maxQ = q12;

  // Score breakdown for RE
  const yearScore = lead?.yearBuilt ? Math.min(100, Math.max(0, (2000 - parseInt(lead.yearBuilt)) / 10)) : 0;
  const sqftScore = lead?.sqft ? Math.min(100, (lead.sqft / 3000) * 100) : 0;
  const psoScore = pso ? 100 : 0;
  const agentScore = lead?.agentPhone ? 100 : lead?.agentEmail ? 60 : 0;

  return (
    <motion.div
      initial={{ x: 440 }}
      animate={{ x: 0 }}
      exit={{ x: 440 }}
      transition={{ type: 'spring', stiffness: 350, damping: 35 }}
      style={{
        position: 'fixed', right: 0, top: 0, bottom: 0, width: 440,
        background: 'rgba(10,10,15,0.97)', backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        borderLeft: '1px solid rgba(255,255,255,0.07)',
        zIndex: 300, display: 'flex', flexDirection: 'column',
        fontFamily: 'Inter, sans-serif',
        overflowY: 'auto',
      }}
    >
      {/* Header */}
      <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <ScoreRing score={lead?.score} size={64} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{
                fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
                padding: '2px 8px', borderRadius: 4,
                background: isFB ? 'rgba(249,115,22,0.15)' : 'rgba(139,92,246,0.15)',
                color: isFB ? '#f97316' : '#8b5cf6',
              }}>
                {isFB ? 'FACEBOOK' : 'REAL ESTATE'}
              </span>
              <StatusPill status={lead?.status} />
            </div>
            <div style={{ fontSize: 15, fontWeight: 800, color: '#F0F0F5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {isFB ? (lead?.group || 'Facebook Lead') : (lead?.address || 'Redfin Lead')}
            </div>
          </div>
          <button onClick={onClose} style={{
            background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 8, width: 32, height: 32, cursor: 'pointer', color: 'rgba(240,240,245,0.6)',
            fontSize: 16, fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>✕</button>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, padding: '20px', overflowY: 'auto' }}>
        {isFB ? (
          <>
            {/* Group badge + View Post link */}
            <Section title="Source">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                {(lead?.groupName || lead?.group) && (
                  <span style={{
                    fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
                    background: 'rgba(249,115,22,0.12)', border: '1px solid rgba(249,115,22,0.3)',
                    color: '#f97316',
                  }}>
                    📢 {lead.groupName || lead.group}
                  </span>
                )}
                {(lead?.postUrl || lead?.url) && (() => {
                  const href = lead.postUrl || lead.url;
                  const isDirectPost = href.includes('/posts/') || href.includes('/permalink/') || href.includes('story_fbid') || href.includes('fbid=');
                  return (
                    <a href={href} target="_blank" rel="noopener noreferrer"
                      style={{
                        fontSize: 13, fontWeight: 700, color: '#fff',
                        textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6,
                        background: isDirectPost ? '#00D47E' : 'rgba(0,212,126,0.15)',
                        border: `1px solid ${isDirectPost ? '#00D47E' : 'rgba(0,212,126,0.4)'}`,
                        padding: '6px 14px', borderRadius: 8,
                      }}>
                      🔗 {isDirectPost ? 'View Post →' : 'View Group →'}
                    </a>
                  );
                })()}
              </div>
            </Section>

            {/* Poster info */}
            {(lead?.posterName || lead?.author) && (
              <Section title="Posted By">
                <div style={{ fontSize: 13, color: '#F0F0F5', display: 'flex', alignItems: 'center', gap: 6 }}>
                  👤{' '}
                  {lead?.posterUrl ? (
                    <a href={lead.posterUrl} target="_blank" rel="noopener noreferrer"
                      style={{ color: '#00D47E', textDecoration: 'none', fontWeight: 600 }}>
                      {lead.posterName || lead.author}
                    </a>
                  ) : (
                    <span style={{ fontWeight: 600 }}>{lead.posterName || lead.author}</span>
                  )}
                </div>
              </Section>
            )}

            {/* Phone */}
            {lead?.phone && (
              <Section title="Phone">
                <a href={`tel:${lead.phone}`}
                  style={{ fontSize: 14, fontWeight: 700, color: '#00D47E', textDecoration: 'none' }}>
                  📞 {lead.phone}
                </a>
              </Section>
            )}

            {/* Post image */}
            {lead?.imageUrl && (
              <Section title="Image">
                <img src={lead.imageUrl} alt="Post" style={{
                  width: '100%', borderRadius: 10, objectFit: 'cover', maxHeight: 200,
                }} />
              </Section>
            )}

            {/* Full post text */}
            <Section title="Post Text">
              <FBPostText text={lead?.description || lead?.text} />
            </Section>

            <Section title="Activity">
              <div style={{ fontSize: 12, color: 'rgba(240,240,245,0.45)' }}>
                Scraped: {lead?.scrapedAt ? new Date(lead.scrapedAt).toLocaleString() : lead?.processedAt ? new Date(getLeadTs(lead)).toLocaleString() : 'Unknown'}
              </div>
            </Section>
          </>
        ) : (
          <>
            <Section title="Property">
              <InfoGrid items={[
                ['Address', lead?.address],
                ['Zip', lead?.zip],
                ['Price', formatPrice(lead?.price)],
                ['Sqft', lead?.sqft ? lead.sqft.toLocaleString() : 'N/A'],
                ['Beds / Baths', `${lead?.beds || '?'} / ${lead?.baths || '?'}`],
                ['Year Built', lead?.yearBuilt],
                ['Days on Market', lead?.dom],
                ['Home Type', lead?.homeType],
              ]} />
            </Section>

            <Section title="Agent">
              <InfoGrid items={[
                ['Name', lead?.agentName || 'N/A'],
                ['Phone', lead?.agentPhone ? <a href={`tel:${lead.agentPhone}`} style={{ color: '#00D47E' }}>{lead.agentPhone}</a> : 'N/A'],
                ['Email', lead?.agentEmail ? <a href={`mailto:${lead.agentEmail}`} style={{ color: '#00D47E' }}>{lead.agentEmail}</a> : 'N/A'],
              ]} />
            </Section>

            {sqft > 0 && (
              <Section title="Insulation Quote">
                <QuoteRow label='8" Blown-In' amount={q8} psoRebate={pso} maxAmount={maxQ} color="#00D47E" />
                <QuoteRow label='10" Blown-In' amount={q10} psoRebate={pso} maxAmount={maxQ} color="#f59e0b" />
                <QuoteRow label='12" Blown-In' amount={q12} psoRebate={pso} maxAmount={maxQ} color="#f97316" />
                {pso && (
                  <div style={{ fontSize: 11, color: '#00D47E', marginTop: 4, fontWeight: 600 }}>
                    ✓ PSO Rebate eligible ($600 — apply at close)
                  </div>
                )}
              </Section>
            )}

            <Section title="Score Breakdown">
              <ProgressBar label="Year Built" value={yearScore} color="#f59e0b" />
              <ProgressBar label="Square Footage" value={sqftScore} color="#f97316" />
              <ProgressBar label="PSO Eligible" value={psoScore} color="#00D47E" />
              <ProgressBar label="Agent Contact" value={agentScore} color="#8b5cf6" />
            </Section>

            {lead?.url && (
              <a href={lead.url} target="_blank" rel="noopener noreferrer" style={{
                display: 'block', textAlign: 'center',
                padding: '10px', borderRadius: 10, marginBottom: 16,
                background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.3)',
                color: '#8b5cf6', fontSize: 13, fontWeight: 700, textDecoration: 'none',
              }}>
                🏠 View Redfin Listing →
              </a>
            )}
          </>
        )}

        <Section title="Notes">
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            onBlur={saveNotes}
            placeholder="Add notes..."
            style={{
              width: '100%', minHeight: 80, background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.09)', borderRadius: 10,
              color: '#F0F0F5', fontSize: 13, padding: '10px 12px',
              fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box',
              outline: 'none', lineHeight: 1.5,
            }}
          />
        </Section>

        {/* Stage Actions */}
        <Section title="Pipeline Stage">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {STAGES.map(st => (
              <ActionBtn
                key={st.key}
                label={st.label}
                color={st.color}
                onClick={() => onStatusChange(lead, st.key)}
                disabled={(lead?.status || 'new') === st.key}
                outline
              />
            ))}
          </div>
        </Section>
      </div>
    </motion.div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{
        fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
        color: 'rgba(240,240,245,0.4)', textTransform: 'uppercase',
        marginBottom: 8,
      }}>{title}</div>
      {children}
    </div>
  );
}

function InfoGrid({ items }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 12px' }}>
      {items.map(([label, value]) => value ? (
        <div key={label}>
          <div style={{ fontSize: 9, color: 'rgba(240,240,245,0.35)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 1 }}>{label}</div>
          <div style={{ fontSize: 13, color: '#F0F0F5', fontWeight: 600 }}>{value}</div>
        </div>
      ) : null)}
    </div>
  );
}

function ActionBtn({ label, color, onClick, disabled, outline }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: 1, minWidth: 100, padding: '10px 12px', borderRadius: 10,
        background: disabled ? 'rgba(255,255,255,0.04)' : outline ? 'transparent' : `${color}20`,
        border: `1px solid ${disabled ? 'rgba(255,255,255,0.08)' : color + '60'}`,
        color: disabled ? 'rgba(240,240,245,0.25)' : color,
        fontSize: 12, fontWeight: 700, cursor: disabled ? 'default' : 'pointer',
        fontFamily: 'inherit', transition: 'all 150ms ease',
      }}
    >
      {label}
    </button>
  );
}

// ─── Stat Card ────────────────────────────────────────────────────────────────
function StatCard({ label, value, icon, color = '#00D47E' }) {
  const animated = useCountUp(value);
  return (
    <div style={{
      flex: 1, minWidth: 120,
      background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)',
      borderRadius: 12, padding: '14px 16px',
    }}>
      <div style={{ fontSize: 10, color: 'rgba(240,240,245,0.4)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 900, color, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
        {label === 'Pipeline Value' ? '$' + animated.toLocaleString() : animated}
      </div>
      {icon && <div style={{ fontSize: 16, marginTop: 4 }}>{icon}</div>}
    </div>
  );
}

// ─── Main LeadHub ─────────────────────────────────────────────────────────────
export default function LeadHub({ onClose }) {
  const [fbLeads, setFbLeads] = useState([]);
  const [reLeads, setReLeads] = useState([]);
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(null);
  const [toast, setToast] = useState(null);
  const [newIds, setNewIds] = useState(new Set());
  const prevIdsRef = useRef(new Set());

  // ── Firestore listeners ───────────────────────────────────────────────────
  useEffect(() => {
    const unsub1 = onSnapshot(collection(db, 'fbLeads'), (snap) => {
      const leads = snap.docs.map(d => ({ ...d.data(), _docId: d.id }));
      leads.sort((a, b) => getLeadTs(b) - getLeadTs(a));

      // Detect new arrivals
      const currentIds = new Set(leads.map(l => l._docId));
      const arrivals = [...currentIds].filter(id => !prevIdsRef.current.has(id) && prevIdsRef.current.size > 0);
      if (arrivals.length) setNewIds(prev => new Set([...prev, ...arrivals]));
      prevIdsRef.current = new Set([...prevIdsRef.current, ...currentIds]);

      setFbLeads(leads);
    });
    const unsub2 = onSnapshot(collection(db, 'reLeads'), (snap) => {
      const leads = snap.docs.map(d => ({ ...d.data(), _docId: d.id, id: d.id }));
      leads.sort((a, b) => getLeadTs(b) - getLeadTs(a));

      const currentIds = new Set(leads.map(l => l._docId));
      const arrivals = [...currentIds].filter(id => !prevIdsRef.current.has(id) && prevIdsRef.current.size > 0);
      if (arrivals.length) setNewIds(prev => new Set([...prev, ...arrivals]));
      prevIdsRef.current = new Set([...prevIdsRef.current, ...currentIds]);

      setReLeads(leads);
    });
    return () => { unsub1(); unsub2(); };
  }, []);

  // Clear flash after 600ms
  useEffect(() => {
    if (newIds.size > 0) {
      const t = setTimeout(() => setNewIds(new Set()), 700);
      return () => clearTimeout(t);
    }
  }, [newIds]);

  // ── Filter logic ──────────────────────────────────────────────────────────
  const allLeads = [...fbLeads, ...reLeads].sort((a, b) => {
    // Hot leads first, then by score desc, then newest first
    if (b.score !== a.score) return (b.score || 0) - (a.score || 0);
    return getLeadTs(b) - getLeadTs(a);
  });

  const filtered = allLeads.filter(l => {
    if (filter === 'all') return true;
    if (filter === 'facebook') return l.source === 'FB';
    if (filter === 'realestate') return l.source === 'Redfin';
    if (filter === 'hot') return l.score >= 8;
    if (filter.startsWith('stage_')) {
      const stage = filter.replace('stage_', '');
      return (l.status || 'new') === stage;
    }
    return true;
  }).sort((a, b) => {
    const pa = isPriorityLead(a) ? 1 : 0;
    const pb = isPriorityLead(b) ? 1 : 0;
    return pb - pa; // priority leads first, preserve existing order within groups
  });

  // ── Stats ─────────────────────────────────────────────────────────────────
  const now = Date.now();
  const newToday = allLeads.filter(l => isNew24h(l.processedAt) || (typeof l.processedAt === 'number' && now - l.processedAt < 86400000)).length;
  const hotLeads = allLeads.filter(l => l.score >= 8).length;
  const pendingFollowUp = allLeads.filter(l => l.status === 'contacted').length;
  // Pipeline value = sum of 8" insulation quotes across all active RE leads
  const pipelineValue = reLeads.filter(l => l.status !== 'dismissed').reduce((sum, l) => {
    const sqft = parseInt(l.sqft) || 0;
    if (!sqft) return sum;
    const gross = Math.round(sqft * 0.80);
    const rebate = sqft > 1000 ? 600 : 0;
    return sum + Math.max(0, gross - rebate);
  }, 0);

  // ── Status change ─────────────────────────────────────────────────────────
  const handleStatusChange = useCallback(async (lead, newStatus) => {
    const isFB = lead.source === 'FB';
    const collName = isFB ? 'fbLeads' : 'reLeads';
    const docId = lead._docId || lead.id;

    // Optimistic update
    if (isFB) {
      setFbLeads(prev => prev.map(l => l._docId === docId ? { ...l, status: newStatus } : l));
    } else {
      setReLeads(prev => prev.map(l => l._docId === docId ? { ...l, status: newStatus } : l));
    }
    if (selected?._docId === docId) {
      setSelected(prev => ({ ...prev, status: newStatus }));
    }

    try {
      await updateDoc(doc(db, collName, docId), { status: newStatus });
      setToast(`✓ Marked as ${newStatus}`);
    } catch (e) {
      console.error('statusChange:', e);
      setToast('⚠️ Failed to update status');
    }
  }, [selected]);

  const FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'facebook', label: 'Facebook' },
    { key: 'realestate', label: 'Real Estate' },
    { key: 'hot', label: '🔥 Hot' },
    // CRM stages
    { key: 'stage_new',       label: 'New',       color: '#3b82f6' },
    { key: 'stage_contacted', label: 'Contacted', color: '#f59e0b' },
    { key: 'stage_quoted',    label: 'Quoted',    color: '#f97316' },
    { key: 'stage_closed',    label: 'Closed',    color: '#10b981' },
    { key: 'stage_dead',      label: 'Dead',      color: '#6b7280' },
  ];

  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: '#0A0A0F', zIndex: 200,
      display: 'flex', flexDirection: 'column',
      fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
      overflowY: 'hidden',
    }}>
      <style>{`
        @keyframes pulseGreen {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.4); opacity: 0.4; }
        }
        @keyframes pulseDot {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.4); opacity: 0.4; }
        }
        @keyframes priorityPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(0, 212, 126, 0.0), inset 0 0 0 1px #00D47E; }
          50% { box-shadow: 0 0 16px 4px rgba(0, 212, 126, 0.35), inset 0 0 0 1px #00D47E; }
        }
      `}</style>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{
        padding: '20px 24px 16px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%', background: '#00D47E',
            animation: 'pulseDot 2s infinite', display: 'inline-block',
          }} />
          <span style={{ fontSize: 18, fontWeight: 900, color: '#F0F0F5', letterSpacing: '0.08em' }}>
            LEAD HUB
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <span style={{ fontSize: 12, color: 'rgba(240,240,245,0.45)' }}>
            {allLeads.length} total · <span style={{ color: '#00D47E', fontWeight: 700 }}>{allLeads.filter(l => l.status === 'new').length} new</span> · <span style={{ color: '#f97316', fontWeight: 700 }}>{hotLeads} hot</span>
          </span>
          <button onClick={onClose} style={{
            background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 8, padding: '6px 12px', color: 'rgba(240,240,245,0.6)',
            fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
          }}>✕ Close</button>
        </div>
      </div>

      {/* ── Stats Strip ────────────────────────────────────────────────────── */}
      <div style={{ padding: '16px 24px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <StatCard label="New Today" value={newToday} color="#00D47E" />
          <StatCard label="Hot Leads" value={hotLeads} color="#f97316" />
          <StatCard label="Pending Follow-ups" value={pendingFollowUp} color="#f59e0b" />
          <StatCard label="Pipeline Value" value={pipelineValue} color="#8b5cf6" />
        </div>
      </div>

      {/* ── Filter Pills ───────────────────────────────────────────────────── */}
      <div style={{ padding: '12px 24px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {FILTERS.map(f => {
            const active = filter === f.key;
            const accent = f.color || '#00D47E';
            return (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                style={{
                  padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 700,
                  cursor: 'pointer', fontFamily: 'inherit', transition: 'all 150ms ease',
                  background: active ? `${accent}18` : 'rgba(255,255,255,0.04)',
                  border: active ? `1px solid ${accent}60` : '1px solid rgba(255,255,255,0.08)',
                  color: active ? accent : 'rgba(240,240,245,0.5)',
                }}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Lead Feed ──────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px 80px' }}>
        {filtered.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            style={{ textAlign: 'center', padding: '80px 0' }}
          >
            <div style={{ fontSize: 48, marginBottom: 12 }}>🎯</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'rgba(240,240,245,0.4)' }}>
              No leads match this filter
            </div>
            <div style={{ fontSize: 13, color: 'rgba(240,240,245,0.25)', marginTop: 6 }}>
              Leads will appear here in real-time
            </div>
          </motion.div>
        ) : (
          filtered.map((lead, idx) => (
            <motion.div
              key={lead._docId || idx}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(idx * 0.04, 0.8) }}
            >
              <LeadCard
                lead={lead}
                onClick={setSelected}
                isNew={newIds.has(lead._docId)}
                onStageChange={handleStatusChange}
              />
            </motion.div>
          ))
        )}
      </div>

      {/* ── Detail Slide-Over ──────────────────────────────────────────────── */}
      <AnimatePresence>
        {selected && (
          <>
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelected(null)}
              style={{
                position: 'fixed', inset: 0, zIndex: 299,
                background: 'rgba(0,0,0,0.4)',
              }}
            />
            <LeadDetail
              key={selected._docId}
              lead={selected}
              onClose={() => setSelected(null)}
              onStatusChange={handleStatusChange}
            />
          </>
        )}
      </AnimatePresence>

      {/* ── Toast ──────────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {toast && (
          <Toast key={toast + Date.now()} message={toast} onDone={() => setToast(null)} />
        )}
      </AnimatePresence>
    </div>
  );
}
