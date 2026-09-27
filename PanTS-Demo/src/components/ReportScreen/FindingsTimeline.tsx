import React, { useEffect, useState } from 'react';

interface OrganNode {
  organ: string;
  status: 'normal' | 'check';
}

interface Props {
  organStatuses: OrganNode[];
  comments: string;
  focusedOrgan?: string | null;
  onNodeTap?: (organ: string) => void;
}

// Order organs by where they first appear in the radiologist's comments
// text ("reading order") rather than alphabetically — this makes the
// timeline feel like it's walking through the case the way it was
// actually read, not just listing data.
function sortByReadingOrder(organStatuses: OrganNode[], comments: string): OrganNode[] {
  const lowerComments = comments.toLowerCase();
  const withIndex = organStatuses.map((node) => {
    const searchTerm = node.organ.replace(/_/g, ' ').split(' ')[0]; // e.g. "kidney_left" -> "kidney"
    const idx = lowerComments.indexOf(searchTerm);
    return { ...node, idx: idx === -1 ? 9999 : idx };
  });
  return withIndex.sort((a, b) => a.idx - b.idx);
}

const STYLES = `
  @keyframes timelineNodeIn {
    from { opacity: 0; transform: translateY(6px) scale(0.6); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes timelineLineIn {
    from { transform: scaleX(0); }
    to { transform: scaleX(1); }
  }
  @keyframes timelineFlagPulse {
    0%, 100% { box-shadow: 0 0 6px rgba(251,191,36,0.6), 0 0 2px rgba(251,191,36,0.9); }
    50% { box-shadow: 0 0 14px rgba(251,191,36,0.9), 0 0 4px rgba(251,191,36,1); }
  }
  @keyframes focusRingPulse {
    0%, 100% { opacity: 0.9; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(1.35); }
  }
`;

export default function FindingsTimeline({ organStatuses, comments, focusedOrgan, onNodeTap }: Props) {
  const [revealed, setRevealed] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  const ordered = sortByReadingOrder(organStatuses, comments);

  // Reveal nodes one at a time, following reading order — gives the
  // sense the AI is "walking through" the case rather than dumping a
  // finished table all at once.
  useEffect(() => {
    if (ordered.length === 0) return;
    setRevealed(0);
    const timers: ReturnType<typeof setTimeout>[] = [];
    ordered.forEach((_, i) => {
      timers.push(setTimeout(() => setRevealed((r) => Math.max(r, i + 1)), 220 + i * 150));
    });
    return () => timers.forEach(clearTimeout);
  }, [ordered.length]);

  if (ordered.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed', bottom: 76, left: '50%', transform: 'translateX(-50%)',
        zIndex: 10001, pointerEvents: 'auto',
        background: 'rgba(10,12,18,0.6)', backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)',
        border: '1px solid rgba(255,255,255,0.08)', borderTop: '1px solid rgba(255,255,255,0.16)',
        borderRadius: 12, padding: '10px 18px',
        display: 'flex', alignItems: 'center', gap: 0,
        boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
        maxWidth: '88vw',
        // NOTE: deliberately no overflowX/Y here — overflow:auto on a flex
        // container clips ANY escaping content (including the hover
        // tooltip, which positions itself above via bottom:100%), even
        // when you only intend to scroll horizontally. Since the node
        // list is short and fits most viewports, we skip scroll affordance
        // entirely rather than reintroduce the clipping bug.
      }}
    >
      <style>{STYLES}</style>
      {ordered.map((node, i) => {
        const isVisible = i < revealed;
        const isFlagged = node.status === 'check';
        const isLast = i === ordered.length - 1;
        const isHovered = hovered === node.organ;
        const isFocused = focusedOrgan === node.organ;
        const friendlyName = node.organ.replace(/_/g, ' ');

        return (
          <React.Fragment key={node.organ}>
            <div
              className="no-drag"
              onClick={() => onNodeTap?.(node.organ)}
              onMouseEnter={() => setHovered(node.organ)}
              onMouseLeave={() => setHovered(null)}
              style={{
                position: 'relative',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
                cursor: 'pointer', flexShrink: 0,
                opacity: isVisible ? 1 : 0,
                animation: isVisible ? 'timelineNodeIn 0.4s ease forwards' : 'none',
              }}
            >
              {isFocused && (
                <div style={{
                  position: 'absolute', top: '50%', left: '50%',
                  width: isFlagged ? 26 : 20, height: isFlagged ? 26 : 20,
                  marginLeft: isFlagged ? -13 : -10, marginTop: isFlagged ? -13 : -10,
                  borderRadius: '50%', border: '1.5px solid rgba(120,170,255,0.9)',
                  animation: 'focusRingPulse 1.6s ease-in-out infinite',
                  pointerEvents: 'none',
                }} />
              )}
              <div
                style={{
                  width: isFlagged ? 13 : 8,
                  height: isFlagged ? 13 : 8,
                  borderRadius: '50%',
                  background: isFlagged ? '#fbbf24' : '#34d399',
                  border: isFocused ? '1.5px solid rgba(120,170,255,0.95)' : '1.5px solid rgba(255,255,255,0.4)',
                  transition: 'all 0.2s ease',
                  transform: isHovered ? 'scale(1.25)' : 'scale(1)',
                  animation: isFlagged && isVisible ? 'timelineFlagPulse 1.8s ease-in-out infinite' : 'none',
                  boxShadow: !isFlagged ? '0 0 5px rgba(52,211,153,0.5)' : undefined,
                  position: 'relative', zIndex: 1,
                }}
              />
              {isHovered && (
                <div
                  style={{
                    position: 'absolute', bottom: '100%', marginBottom: 8,
                    background: 'rgba(10,12,18,0.96)', border: '0.5px solid rgba(255,255,255,0.14)',
                    borderRadius: 6, padding: '4px 9px', whiteSpace: 'nowrap',
                    fontSize: 9.5, color: isFlagged ? '#fcd34d' : 'rgba(255,255,255,0.7)',
                    textTransform: 'capitalize', fontWeight: 500,
                    boxShadow: '0 2px 12px rgba(0,0,0,0.5)',
                    zIndex: 20,
                  }}
                >
                  {friendlyName}{isFlagged ? ' · review' : ' · tap to view finding'}
                </div>
              )}
            </div>
            {!isLast && (
              <div
                style={{
                  width: 22, height: 1,
                  background: 'rgba(255,255,255,0.15)',
                  transformOrigin: 'left',
                  transform: isVisible ? 'scaleX(1)' : 'scaleX(0)',
                  transition: 'transform 0.3s ease',
                  flexShrink: 0,
                }}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}