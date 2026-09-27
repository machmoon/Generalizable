import { useState } from "react";
import { IconEye, IconEyeOff, IconTrash } from "@tabler/icons-react";
import type { CheckBoxData } from "../../types";

interface SegmentsTableProps {
  segments: CheckBoxData[];
  colors: Record<number, string>; // hex
  visibility: Record<number, boolean>;
  activeSegmentId: number;
  onSelect: (id: number) => void;
  onRename: (id: number, name: string) => boolean; // returns false if rejected (dup)
  onColorChange: (id: number, hex: string) => void;
  onToggleVisibility: (id: number) => void;
  onDelete: (id: number) => void;
}

export default function SegmentsTable({
  segments, colors, visibility, activeSegmentId,
  onSelect, onRename, onColorChange, onToggleVisibility, onDelete,
}: SegmentsTableProps) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<number | null>(null);

  const startEdit = (id: number, current: string) => {
    setEditingId(id);
    setDraft(current);
    setError(null);
  };

  const commitEdit = (id: number) => {
    const trimmed = draft.trim();
    if (!trimmed) { setEditingId(null); return; }
    const dup = segments.some((s) => s.id !== id && s.label.toLowerCase() === trimmed.toLowerCase());
    if (dup) { setError(id); return; }
    const ok = onRename(id, trimmed);
    if (ok) { setEditingId(null); setError(null); }
    else setError(id);
  };

  return (
    <div className="seg-table">
      <div className="seg-table__row seg-table__row--head">
        <span /> <span /> <span>Name</span> <span />
      </div>
      {segments.map((s) => (
        <div
          key={s.id}
          className={`seg-table__row ${activeSegmentId === s.id ? "is-active" : ""}`}
          onClick={() => onSelect(s.id)}
        >
          <button
            className="seg-table__vis"
            onClick={(e) => { e.stopPropagation(); onToggleVisibility(s.id); }}
            aria-label={visibility[s.id] ? "Hide class" : "Show class"}
          >
            {visibility[s.id] !== false ? <IconEye size={16} /> : <IconEyeOff size={16} />}
          </button>
          <input
            type="color"
            className="seg-table__color"
            value={colors[s.id] ?? "#ffffff"}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onColorChange(s.id, e.target.value)}
          />
          {editingId === s.id ? (
            <input
              autoFocus
              className={`seg-table__name-input ${error === s.id ? "is-error" : ""}`}
              value={draft}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => { setDraft(e.target.value); setError(null); }}
              onBlur={() => commitEdit(s.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitEdit(s.id);
                if (e.key === "Escape") { setEditingId(null); setError(null); }
              }}
            />
          ) : (
            <span
              className="seg-table__name"
              onDoubleClick={(e) => { e.stopPropagation(); startEdit(s.id, s.label); }}
              title="Double-click to rename"
            >
              {s.label}
            </span>
          )}
          <button
            className="seg-table__delete"
            onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
            aria-label="Delete class"
          >
            <IconTrash size={14} />
          </button>
          {error === s.id && <span className="seg-table__err">Name already used</span>}
        </div>
      ))}
    </div>
  );
}