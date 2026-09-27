import React, { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { APP_CONSTANTS } from '../helpers/constants';
import type { ReportData, OrganData } from '../helpers/reportFindings';
import {
  splitOrgans,
  labelize,
  organRoot,
  getReportMeasurements,
  patientFindingText,
} from '../helpers/reportFindings';

const NAVY = '#14265C';
const NAVY_DEEP = '#0D1B47';
const SPIRIT_TEXT = '#3E6FB5';
const AMBER = '#B8720A';
const AMBER_BG = '#FBF1E1';
const GREEN = '#0E7C4A';
const INK = '#141A26';
const MUTED = '#5A6B85';
const HAIRLINE = '#E7EAF0';
const PANEL = '#F7F9FC';

// Save the JHU shield you provided into your repo at this exact path
// (e.g. PanTS-Demo/public/jhu-shield-white.png) — Vite serves anything in
// public/ from the site root, so this path resolves automatically once
// the file's there. If it's missing, the <img> just quietly hides itself.
const JHU_SHIELD_SRC = '/jhu-shield-white.png';

const STYLES = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Poppins:wght@600;700;800&display=swap');
@keyframes fadeUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
@keyframes shareGlow { 0%,100% { box-shadow: 0 6px 20px rgba(20,38,92,0.28); } 50% { box-shadow: 0 8px 26px rgba(20,38,92,0.4); } }

.spc-share {
  position: relative;
  overflow: hidden;
  background: linear-gradient(135deg, #14265C 0%, #1E3573 60%, #2A4590 100%);
  animation: shareGlow 2.8s ease-in-out infinite;
  transition: transform 0.28s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.28s ease;
}
.spc-share::before {
  content: '';
  position: absolute;
  top: 0; left: -60%;
  width: 40%; height: 100%;
  background: linear-gradient(120deg, transparent, rgba(255,255,255,0.4), transparent);
  transform: skewX(-20deg);
  transition: left 0.65s cubic-bezier(0.16,1,0.3,1);
}
.spc-share:hover {
  transform: translateY(-2px) scale(1.035);
  animation-play-state: paused;
  box-shadow: 0 12px 28px rgba(20,38,92,0.42);
}
.spc-share:hover::before { left: 140%; }
.spc-share:active { transform: translateY(0) scale(0.97); }
.spc-share .spc-share-icon { transition: transform 0.3s cubic-bezier(0.34,1.56,0.64,1); }
.spc-share:hover .spc-share-icon { transform: translateY(-2px) rotate(-8deg); }

.spc-chip { transition: background 0.2s, color 0.2s; cursor: pointer; }
.spc-ad:hover { background: ${NAVY_DEEP} !important; }
.spc-qr-wrap { transition: transform 0.25s cubic-bezier(0.34,1.5,0.64,1); }
.spc-qr-wrap:hover { transform: scale(1.05); }
`;

const CARD_MAX = 640;

// Dedupe by organ root — pancreas + pancreas_tail are the same underlying
// finding; without this a case can wrongly claim "2 findings" for one organ.
function dedupeFindingsByRoot(flagged: [string, OrganData][]): { root: string; organ: string; data: OrganData }[] {
  const byRoot = new Map<string, { root: string; organ: string; data: OrganData }>();
  for (const [organ, data] of flagged) {
    const root = organRoot(organ);
    const existing = byRoot.get(root);
    if (!existing || organ === root) byRoot.set(root, { root, organ, data });
  }
  return Array.from(byRoot.values());
}

// Staggered entrance delay helper — each major section fades/rises in a
// beat after the previous one instead of everything appearing at once.
function stagger(revealed: boolean, index: number): React.CSSProperties {
  return revealed ? { animation: `fadeUp 0.45s cubic-bezier(0.16,1,0.3,1) ${index * 0.08}s both` } : { opacity: 0 };
}

export default function SharePatientCard() {
  const { shareId = '' } = useParams<{ shareId: string }>();
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState(false);
  const [noOrganData, setNoOrganData] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`${APP_CONSTANTS.API_ORIGIN}/api/share/${shareId}`)
      .then(r => r.json())
      .then(j => {
        if (cancelled) return;
        if (j.error) { setError(true); return; }
        if (j.masks_available === false || !j.organ_volumes || Object.keys(j.organ_volumes).length === 0) {
          setNoOrganData(true);
          return;
        }
        setData(j);
      })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [shareId]);

  useEffect(() => {
    if (!data) return;
    const t = setTimeout(() => setRevealed(true), 30);
    return () => clearTimeout(t);
  }, [data]);

  const { flagged, normal } = useMemo(() => splitOrgans(data), [data]);
  const findings = useMemo(() => dedupeFindingsByRoot(flagged), [flagged]);
  const allClear = data ? findings.length === 0 : false;

  const active = findings[activeIdx] ?? null;
  const measurements = active && data ? getReportMeasurements(active.organ, data.comments || '') : null;
  const plainLanguage = active && measurements ? patientFindingText(active.organ, measurements) : null;

  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  };

  const bodyMapsUrl = 'https://bodymaps.wse.jhu.edu';
  const shareUrl = typeof window !== 'undefined' ? window.location.href : '';
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=96x96&margin=0&color=255-255-255&bgcolor=20-38-92&data=${encodeURIComponent(shareUrl)}`;

  return (
    <div style={page}>
      <style>{STYLES}</style>

      <div style={stage}>
        {!data && !error && !noOrganData && (
          <div style={loadingWrap}><div style={spinnerRing} /></div>
        )}

        {error && (
          <div style={emptyState}><div style={emptyStateTitle}>This report link isn't available.</div></div>
        )}

        {noOrganData && (
          <div style={emptyState}>
            <div style={emptyStateTitle}>No mapped organ data available for this case.</div>
          </div>
        )}

        {data && (
          <div style={{ ...card, ...stagger(revealed, 0) }}>
            <div style={cardBody}>
              {/* Identity */}
              <a href={bodyMapsUrl} target="_blank" rel="noreferrer" style={{ ...brandLockup, ...stagger(revealed, 1) }}>
                <div style={brandMark}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="8.4" stroke="#fff" strokeWidth="1.6" />
                    <circle cx="12" cy="12" r="3" fill="#fff" />
                  </svg>
                </div>
                <div>
                  <div style={brandName}>BodyMaps</div>
                  <div style={brandSub}>Johns Hopkins University</div>
                </div>
              </a>

              <div style={stagger(revealed, 2)}>
                <div style={eyebrow}>CT SCAN SUMMARY</div>
                <div style={statLineWrap}>
                  <span style={{ ...statAccentBar, background: allClear ? GREEN : AMBER }} />
                  <span style={{ ...statLine, color: allClear ? GREEN : AMBER }}>
                    {allClear ? 'All clear' : `${findings.length} organ${findings.length === 1 ? '' : 's'} with findings`}
                  </span>
                </div>
                {!allClear && normal.length > 0 && (
                  <p style={subStatLine}>{normal.length} other mapped structure{normal.length === 1 ? '' : 's'} showed no flagged findings.</p>
                )}
              </div>

              {!allClear && active && findings.length > 1 && (
                <div style={{ ...chipRow, ...stagger(revealed, 3) }}>
                  {findings.map((f, i) => (
                    <span key={f.root} className="spc-chip" onClick={() => setActiveIdx(i)} style={chip(i === activeIdx)}>
                      {labelize(f.root)}
                    </span>
                  ))}
                </div>
              )}

              {!allClear && active && (
                <>
                  <div style={{ ...panel, ...stagger(revealed, 4) }}>
                    <div style={panelInner}>
                      {/* Organ image slot — intentionally left empty for your
                          own illustration/render. */}
                      <div style={organImageSlot} />

                      <div style={{ flex: 1, minWidth: 200 }}>
                        <div style={panelLabel}>PRIMARY FINDING</div>
                        <div style={organNameBig}>{labelize(active.root)}</div>
                        <div style={findingBadge}>
                          <GearIcon /> Finding to review
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Radiology Impression sits right below the organ name —
                      this is the most important line on the card, sized up
                      accordingly. */}
                  <div style={{ ...impressionPanel, ...stagger(revealed, 5) }}>
                    <div style={impressionIconWrap}><DocIcon /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={impressionLabel}>RADIOLOGY IMPRESSION</div>
                      <p style={impressionText}>{plainLanguage || 'This organ was flagged for your doctor to review.'}</p>
                    </div>
                  </div>

                  {(measurements?.organVolumeCc != null || measurements?.organMeanHu != null) && (
                    <div style={stagger(revealed, 6)}>
                      <div style={sectionLabel}>KEY MEASUREMENTS</div>
                      <div style={measureCardsRow}>
                        {measurements?.organVolumeCc != null && (
                          <div style={measureCard}>
                            <div style={measureIconWrap}><CubeIcon /></div>
                            <div style={measureLabel}>{labelize(active.root)} volume</div>
                            <div style={measureValue}>{measurements.organVolumeCc.toFixed(1)} cm³</div>
                            <div style={measureSub}>Measured from segmentation</div>
                          </div>
                        )}
                        {measurements?.organMeanHu != null && (
                          <div style={measureCard}>
                            <div style={measureIconWrap}><PulseIcon /></div>
                            <div style={measureLabel}>Mean attenuation</div>
                            <div style={measureValue}>{measurements.organMeanHu.toFixed(1)} HU</div>
                            <div style={measureSub}>Measured from CT data</div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}

              {allClear && (
                <p style={{ ...impressionText, marginTop: 14, fontSize: 14 }}>
                  All {normal.length} reviewed structure{normal.length === 1 ? '' : 's'} looked healthy on this scan.
                </p>
              )}

              <div style={hairline} />

              <div style={{ ...actionsRow, ...stagger(revealed, 7) }}>
                <button className="spc-share" onClick={handleShare} style={shareInlineBtn}>
                  <span className="spc-share-icon" style={{ display: 'inline-flex' }}><ShareIcon /></span>
                  {copied ? 'Link copied' : 'Share this BodyMap'}
                </button>
              </div>
            </div>

            {/* Big navy advertising footer — JHU shield, BodyMaps, link, and
                the QR code all together, replacing the smaller de-identified
                text block that used to sit above it. */}
            <a
              href={bodyMapsUrl}
              target="_blank"
              rel="noreferrer"
              className="spc-ad"
              style={{ ...adBar, ...stagger(revealed, 8) }}
            >
              <div style={adLeft}>
                <img
                  src={JHU_SHIELD_SRC}
                  alt="Johns Hopkins University"
                  style={adShield}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
                <div style={adDivider} />
                <div>
                  <div style={adTitle}>BodyMaps</div>
                  <div style={adUrl}>bodymaps.wse.jhu.edu</div>
                </div>
              </div>
              <div className="spc-qr-wrap" style={adQrWrap}>
                <img src={qrSrc} alt="QR code to this BodyMap" width={56} height={56} style={adQrImg} />
              </div>
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

function GearIcon() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" style={{ marginRight: 5 }}><circle cx="12" cy="12" r="3" stroke={AMBER} strokeWidth="2" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" stroke={AMBER} strokeWidth="2" strokeLinecap="round" /></svg>;
}
function CubeIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" stroke={SPIRIT_TEXT} strokeWidth="1.7" strokeLinejoin="round" /><path d="M4 7.5L12 12l8-4.5M12 12v9" stroke={SPIRIT_TEXT} strokeWidth="1.7" strokeLinejoin="round" /></svg>;
}
function PulseIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M3 12h4l2-7 4 14 2-7h6" stroke={SPIRIT_TEXT} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function DocIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M6 3h9l5 5v13a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" /><path d="M14 3v5h5" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" /><path d="M8 13h8M8 17h8" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}
function ShareIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ marginRight: 7 }}><path d="M12 3v13M8 7l4-4 4 4" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><path d="M5 13v6a1 1 0 001 1h12a1 1 0 001-1v-6" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

// ─── Style tokens ───────────────────────────────────────────────────────────

const page: React.CSSProperties = {
  minHeight: '100vh', width: '100%', background: '#FBFCFE',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: '36px 20px', fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
};

const stage: React.CSSProperties = { width: '100%', maxWidth: CARD_MAX };

const loadingWrap: React.CSSProperties = { display: 'flex', justifyContent: 'center', padding: '80px 0' };
const spinnerRing: React.CSSProperties = { width: 22, height: 22, borderRadius: '50%', border: `2px solid ${HAIRLINE}`, borderTopColor: NAVY, animation: 'spin 0.8s linear infinite' };

const emptyState: React.CSSProperties = { textAlign: 'center', padding: '44px 24px', border: `1px solid ${HAIRLINE}`, borderRadius: 16, background: '#fff' };
const emptyStateTitle: React.CSSProperties = { fontSize: 14.5, fontWeight: 600, color: MUTED };

const card: React.CSSProperties = {
  background: '#ffffff', borderRadius: 18, border: `1px solid ${HAIRLINE}`,
  boxShadow: '0 12px 32px rgba(20,38,92,0.08)', overflow: 'hidden',
};
const cardBody: React.CSSProperties = { padding: '24px 26px 6px' };

const brandLockup: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', marginBottom: 14 };
const brandMark: React.CSSProperties = { width: 30, height: 30, borderRadius: 8, background: NAVY, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 };
const brandName: React.CSSProperties = { fontFamily: "'Poppins', sans-serif", fontWeight: 700, fontSize: 19, color: NAVY, lineHeight: 1.15 };
const brandSub: React.CSSProperties = { fontSize: 11, color: MUTED, fontWeight: 500 };

const eyebrow: React.CSSProperties = { fontSize: 10.5, fontWeight: 750, letterSpacing: '0.1em', color: SPIRIT_TEXT };
const statLineWrap: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, marginTop: 5 };
const statAccentBar: React.CSSProperties = { width: 4, height: 24, borderRadius: 2, flexShrink: 0 };
const statLine: React.CSSProperties = { fontSize: 26, fontWeight: 700, fontFamily: "'Poppins', sans-serif" };
const subStatLine: React.CSSProperties = { fontSize: 13, color: MUTED, marginTop: 6, marginBottom: 4, marginLeft: 14 };

const chipRow: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 14 };
const chip = (active: boolean): React.CSSProperties => ({
  fontSize: 11.5, fontWeight: 650, padding: '5px 11px', borderRadius: 999,
  background: active ? NAVY : '#F1F4F9', color: active ? '#fff' : MUTED,
});

const panel: React.CSSProperties = { marginTop: 14, padding: '18px 20px', borderRadius: 14, background: PANEL, border: `1px solid ${HAIRLINE}` };
const panelInner: React.CSSProperties = { display: 'flex', gap: 18, flexWrap: 'wrap' };
const organImageSlot: React.CSSProperties = {
  width: 140, height: 140, borderRadius: 12, flexShrink: 0,
  background: '#fff', border: `1px dashed ${HAIRLINE}`,
};
const panelLabel: React.CSSProperties = { fontSize: 10, fontWeight: 750, letterSpacing: '0.08em', color: SPIRIT_TEXT };
const organNameBig: React.CSSProperties = { fontFamily: "'Poppins', sans-serif", fontSize: 26, fontWeight: 700, color: INK, marginTop: 4, marginBottom: 10 };
const findingBadge: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', fontSize: 12, fontWeight: 700, color: AMBER, background: AMBER_BG,
  padding: '5px 12px', borderRadius: 999, border: '1px solid #EAD2A6',
};

const sectionLabel: React.CSSProperties = { fontSize: 10.5, fontWeight: 750, letterSpacing: '0.08em', color: SPIRIT_TEXT, marginTop: 20, marginBottom: 8 };
const measureCardsRow: React.CSSProperties = { display: 'flex', gap: 10 };
const measureCard: React.CSSProperties = { flex: 1, padding: '13px 14px', borderRadius: 12, background: PANEL, border: `1px solid ${HAIRLINE}` };
const measureIconWrap: React.CSSProperties = { width: 26, height: 26, borderRadius: 8, background: '#E8F0FB', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 8 };
const measureLabel: React.CSSProperties = { fontSize: 10, fontWeight: 700, color: SPIRIT_TEXT, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.02em' };
const measureValue: React.CSSProperties = { fontFamily: "'Poppins', sans-serif", fontSize: 19, fontWeight: 700, color: INK };
const measureSub: React.CSSProperties = { fontSize: 10.5, color: '#9AA5B8', marginTop: 2 };

const impressionPanel: React.CSSProperties = {
  display: 'flex', gap: 14, marginTop: 14, padding: '18px 20px',
  background: '#EFF4FB', border: `1px solid ${HAIRLINE}`, borderRadius: 14,
};
const impressionIconWrap: React.CSSProperties = { width: 32, height: 32, borderRadius: 9, background: SPIRIT_TEXT, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 };
const impressionLabel: React.CSSProperties = { fontSize: 11, fontWeight: 750, letterSpacing: '0.08em', color: SPIRIT_TEXT, marginBottom: 7 };
const impressionText: React.CSSProperties = { fontSize: 17, lineHeight: 1.5, color: INK, margin: 0, fontWeight: 500 };

const hairline: React.CSSProperties = { height: 1, background: HAIRLINE, margin: '16px 0 12px' };

const actionsRow: React.CSSProperties = { display: 'flex', justifyContent: 'center', marginBottom: 16 };
const shareInlineBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', padding: '13px 28px', borderRadius: 999, border: 'none',
  color: '#fff', fontSize: 14, fontWeight: 700, letterSpacing: '0.01em', cursor: 'pointer', fontFamily: 'inherit',
};

// Bigger, single "advertising" footer — replaces both the old small
// de-identified text block and the thin bottom bar with one prominent band.
const adBar: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '22px 28px', background: NAVY, textDecoration: 'none', transition: 'background 0.2s',
};
const adLeft: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 16 };
const adShield: React.CSSProperties = { height: 40, width: 'auto' };
const adDivider: React.CSSProperties = { width: 1, height: 34, background: 'rgba(255,255,255,0.22)' };
const adTitle: React.CSSProperties = { fontFamily: "'Poppins', sans-serif", fontSize: 16, fontWeight: 700, color: '#fff' };
const adUrl: React.CSSProperties = { fontSize: 12, color: '#AFC2E8', marginTop: 2, fontWeight: 600 };
const adQrWrap: React.CSSProperties = { padding: 5, background: '#fff', borderRadius: 10, flexShrink: 0 };
const adQrImg: React.CSSProperties = { display: 'block', borderRadius: 4 };
