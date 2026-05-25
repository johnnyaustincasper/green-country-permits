'use client';

import { useEffect, useState } from 'react';
import { logVisit, getVisitsForPermit, deleteVisit } from '../../lib/visitTracking';
import { LIQUID_GLASS, glassStyle } from '../../lib/theme';

const T = LIQUID_GLASS;

export default function VisitModal({ permit, salesman, onClose }) {
  const [visits, setVisits] = useState([]);
  const [loading, setLoading] = useState(false);
  const [visitDate, setVisitDate] = useState(new Date().toISOString().split('T')[0]);
  const [visitTime, setVisitTime] = useState(new Date().toTimeString().slice(0, 5));
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    loadVisits();
  }, [permit?.id]);

  async function loadVisits() {
    setLoading(true);
    const visitList = await getVisitsForPermit(permit?.id);
    setVisits(visitList);
    setLoading(false);
  }

  async function handleLogVisit() {
    if (!visitDate) return;
    setSubmitting(true);
    try {
      const dateTime = new Date(`${visitDate}T${visitTime || '09:00'}`);
      await logVisit(salesman, permit.id, permit.builder, dateTime, notes);
      setNotes('');
      setVisitDate(new Date().toISOString().split('T')[0]);
      setVisitTime(new Date().toTimeString().slice(0, 5));
      await loadVisits();
    } catch (error) {
      console.error('Failed to log visit:', error);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeleteVisit(visitId) {
    if (!confirm('Delete this visit?')) return;
    try {
      await deleteVisit(visitId);
      await loadVisits();
    } catch (error) {
      console.error('Failed to delete visit:', error);
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.3)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          ...glassStyle(0.95),
          borderRadius: 16,
          maxWidth: 500,
          width: '90%',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px',
            borderBottom: `1px solid rgba(255,255,255,0.6)`,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'rgba(255,255,255,0.3)',
          }}
        >
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>
              {permit?.builder}
            </div>
            <div style={{ fontSize: 13, color: T.textMuted, marginTop: 2 }}>
              {permit?.address}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: 24,
              color: T.textMuted,
              cursor: 'pointer',
            }}
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
          {/* Log Visit Form */}
          <div
            style={{
              ...glassStyle(0.8),
              borderRadius: 12,
              padding: 12,
              marginBottom: 16,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, color: T.indigo, marginBottom: 10 }}>
              📝 Log New Visit
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
              <input
                type="date"
                value={visitDate}
                onChange={e => setVisitDate(e.target.value)}
                style={{
                  padding: '8px 10px',
                  border: `1px solid rgba(255,255,255,0.6)`,
                  borderRadius: 8,
                  fontSize: 13,
                  fontFamily: 'inherit',
                  background: 'rgba(255,255,255,0.4)',
                  color: T.text,
                }}
              />
              <input
                type="time"
                value={visitTime}
                onChange={e => setVisitTime(e.target.value)}
                style={{
                  padding: '8px 10px',
                  border: `1px solid rgba(255,255,255,0.6)`,
                  borderRadius: 8,
                  fontSize: 13,
                  fontFamily: 'inherit',
                  background: 'rgba(255,255,255,0.4)',
                  color: T.text,
                }}
              />
            </div>
            <textarea
              placeholder="Visit notes…"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              style={{
                width: '100%',
                minHeight: 70,
                padding: '8px 10px',
                border: `1px solid rgba(255,255,255,0.6)`,
                borderRadius: 8,
                fontSize: 13,
                fontFamily: 'inherit',
                resize: 'none',
                background: 'rgba(255,255,255,0.4)',
                color: T.text,
              }}
            />
            <button
              onClick={handleLogVisit}
              disabled={submitting || !visitDate}
              style={{
                width: '100%',
                marginTop: 10,
                padding: '10px 12px',
                background: submitting || !visitDate ? '#ccc' : T.blue,
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                cursor: submitting || !visitDate ? 'default' : 'pointer',
              }}
            >
              {submitting ? 'Saving...' : 'Log Visit'}
            </button>
          </div>

          {/* Visit History */}
          <div style={{ fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 10 }}>
            Visit History ({visits.length})
          </div>
          {loading ? (
            <div style={{ color: T.textMuted, fontSize: 13, textAlign: 'center', padding: '20px 0' }}>
              Loading…
            </div>
          ) : visits.length === 0 ? (
            <div style={{ color: T.textMuted, fontSize: 13, textAlign: 'center', padding: '20px 0' }}>
              No visits logged yet
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {visits.map(visit => (
                <div
                  key={visit.id}
                  style={{
                    ...glassStyle(0.7),
                    borderRadius: 10,
                    padding: 12,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>
                        {visit.salesman}
                      </div>
                      <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>
                        {visit.visitDate.toLocaleDateString()} at{' '}
                        {visit.visitDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                      {visit.notes && (
                        <div
                          style={{
                            fontSize: 12,
                            color: T.textSub,
                            marginTop: 6,
                            fontStyle: 'italic',
                          }}
                        >
                          "{visit.notes}"
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => handleDeleteVisit(visit.id)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#ef4444',
                        cursor: 'pointer',
                        fontSize: 14,
                      }}
                      title="Delete visit"
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
