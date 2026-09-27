// ─────────────────────────────────────────────────────────────────────────
// Shared report-text parsing + plain-language finding logic.
//
// This is a straight extraction of the pure helper functions that already
// live in ReportScreen.tsx (organRoot, getReportSection, getReportMeasurements,
// patientFindingText, etc). Nothing about their behavior has changed — same
// regexes, same bug-fix comments preserved — they've just been moved here so
// a second surface (the shareable patient card) can reuse the identical
// logic instead of re-implementing it and risking the two drifting apart.
//
// ReportScreen.tsx can optionally switch to importing from here instead of
// keeping its own copies; that's a one-line import swap per function and is
// left as a follow-up so it doesn't touch the verified report-walkthrough
// flow in this change.
// ─────────────────────────────────────────────────────────────────────────

export interface OrganData {
  volume: number;
  mean_hu: number;
  status?: 'normal' | 'check';
  centroid_mm?: [number, number, number];
  dimensions?: [number, number, number];
}

export interface ReportData {
  case_id: string;
  patient: { age: number; sex: string };
  imaging: { study_type: string; contrast: string; spacing: number[]; shape: number[] };
  organ_volumes: { [k: string]: OrganData };
  lesions: { [k: string]: { voxels: number; volume: number } };
  comments: string;
  impression: string[];
}

export type ReportMeasurements = {
  section: string | null;
  volumeCc: number | null;
  lesionVolumeCc: number | null;
  organVolumeCc: number | null;
  meanHu: number | null;
  organMeanHu: number | null;
  huSd: number | null;
  sizeCm: string | null;
  lesionCount: number;
};

export function labelize(organ: string): string {
  return organ
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

export function getDetail(organ: string, comments: string): string | null {
  if (!comments) return null;
  const sentences = comments.split(/(?<=[.!?])\s+/).filter(s => s.trim());
  const root = organ.replace(/_(gland|body|tail|head|left|right)$/, '').replace(/_/g, ' ').split(' ')[0];
  const match = sentences.find(s => s.toLowerCase().includes(root.toLowerCase()));
  if (!match) return null;
  let d = match.trim().replace(/^(however|notably|additionally|furthermore|moreover|in addition),?\s+/i, '');
  if (d.length) d = d[0].toUpperCase() + d.slice(1);
  if (d.length > 210) d = d.slice(0, d.lastIndexOf(' ', 207)).trim() + '...';
  return d.endsWith('.') || d.endsWith('...') ? d : d + '.';
}

export function organRoot(organ: string): string {
  if (organ.startsWith('pancreas')) return 'pancreas';
  if (organ.startsWith('kidney')) return 'kidney';
  return organ
    .replace(/_(gland|body|tail|head|left|right)$/, '')
    .replace(/_/g, ' ')
    .toLowerCase();
}

export function getReportSection(organ: string, comments: string): string | null {
  if (!comments) return null;
  const root = organRoot(organ);
  const lines = comments.split(/\r?\n/);
  const start = lines.findIndex(line => {
    const cleaned = line.trim().replace(/:$/, '').toLowerCase();
    return cleaned === root || cleaned === `${root}s` || cleaned.startsWith(`${root}:`);
  });
  if (start === -1) return getDetail(organ, comments);
  const collected: string[] = [];
  let lesionsHeadingSeen = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const cleanedHeading = trimmed.replace(/:$/, '').toLowerCase();
    if (i > start && cleanedHeading === `${root} lesions`) {
      lesionsHeadingSeen = true;
      continue;
    }
    if (i > start && !lesionsHeadingSeen && /^[A-Za-z][A-Za-z\s_/-]*:\s*$/.test(trimmed)) break;
    if (i > start && lesionsHeadingSeen && /^[A-Za-z][A-Za-z\s_/-]*:\s*$/.test(trimmed) && !cleanedHeading.startsWith(root)) break;
    if (i > start && /^IMPRESSION:\s*$/i.test(trimmed)) break;
    if (trimmed) collected.push(trimmed);
  }
  return collected.join(' ').replace(/\s+/g, ' ').trim() || null;
}

export function getReportMeasurements(organ: string, comments: string): ReportMeasurements {
  const section = getReportSection(organ, comments);
  const lesionVolumeMatch = section?.match(/lesion[\s\S]*?volume:\s*([\d.]+)\s*cc/i);
  const lesionHuMatch = section?.match(/hu\s*value\s*is\s*(-?[\d.]+)(?:\s*\+\/-\s*([\d.]+))?/i);
  const volumeMatch = lesionVolumeMatch ?? section?.match(/volume:\s*([\d.]+)\s*cc/i);
  const huMatch = lesionHuMatch ?? section?.match(/Mean HU value:\s*([\d.]+)(?:\s*\+\/-\s*([\d.]+))?/i);
  const sizeMatch = section?.match(/Size:\s*([^()]+?)\s*cm/i);

  const organVolumeMatch = section?.match(/volume:\s*([\d.]+)\s*cc/i);
  const organHuMatch = section?.match(/Mean HU value:\s*([\d.]+)/i);

  const sizeMatches = section?.match(/Size:\s*[^()]+?cm/gi) ?? [];
  const lesionCount = sizeMatches.length || (lesionVolumeMatch ? 1 : 0);

  return {
    section,
    volumeCc: volumeMatch ? Number(volumeMatch[1]) : null,
    lesionVolumeCc: lesionVolumeMatch ? Number(lesionVolumeMatch[1]) : null,
    organVolumeCc: organVolumeMatch ? Number(organVolumeMatch[1]) : null,
    meanHu: huMatch ? Number(huMatch[1]) : null,
    organMeanHu: organHuMatch ? Number(organHuMatch[1]) : null,
    huSd: huMatch?.[2] ? Number(huMatch[2]) : null,
    sizeCm: sizeMatch ? sizeMatch[1].trim() : null,
    lesionCount,
  };
}

export function organLocation(organ: string): { type: 'lateral' | 'subregion'; word: string } | null {
  const suffix = organ.split('_').pop() ?? '';
  if (suffix === 'left' || suffix === 'right') return { type: 'lateral', word: suffix };
  if (suffix === 'tail' || suffix === 'head' || suffix === 'body') return { type: 'subregion', word: suffix };
  return null;
}

export function sizeDescriptor(volumeCc: number | null, sizeCm: string | null): string {
  let maxDim: number | null = null;
  if (sizeCm) {
    const nums = sizeCm.match(/[\d.]+/g)?.map(Number) ?? [];
    if (nums.length) maxDim = Math.max(...nums);
  }
  if (maxDim !== null) {
    if (maxDim < 1) return 'tiny';
    if (maxDim < 2) return 'small';
    if (maxDim < 5) return 'noticeable';
    return 'sizable';
  }
  if (volumeCc !== null) {
    if (volumeCc < 1) return 'tiny';
    if (volumeCc < 5) return 'small';
    if (volumeCc < 20) return 'noticeable';
    return 'sizable';
  }
  return '';
}

// Definitions, not interpretations — these describe what each clinical
// word means in plain English without implying severity, urgency, or a
// diagnosis (never "benign," "concerning," "normal," etc. — only what the
// source report actually supports). `kind` picks the sentence grammar:
// 'noun' terms slot into "a small <term>"; 'descriptor' terms (enlarged,
// dilated) describe a state of the organ itself, so they get their own
// sentence shape rather than being forced into "a small enlarged."
type FindingTerm = { term: string; kind: 'noun' | 'descriptor'; definition: string };

function detectFindingTerm(detail: string): FindingTerm | null {
  const d = detail.toLowerCase();
  if (d.includes('cyst')) return { term: 'cyst', kind: 'noun', definition: 'A cyst is a fluid-filled sac.' };
  if (d.includes('nodule')) return { term: 'nodule', kind: 'noun', definition: 'A nodule is a small rounded area.' };
  if (d.includes('mass')) return { term: 'mass', kind: 'noun', definition: 'A mass is an area of tissue that appears different from the surrounding tissue.' };
  if (d.includes('tumor')) return { term: 'tumor', kind: 'noun', definition: 'A tumor is a growth made up of abnormal cells.' };
  if (d.includes('enlarged')) return { term: 'enlarged', kind: 'descriptor', definition: 'Enlarged means larger than expected.' };
  if (d.includes('dilated') || d.includes('widened')) return { term: 'dilated', kind: 'descriptor', definition: 'Dilated means wider than expected.' };
  if (d.includes('lesion')) return { term: 'lesion', kind: 'noun', definition: 'A lesion is an area that looks different from the surrounding tissue.' };
  return null;
}

export function getImpressionText(data: ReportData | null): string {
  if (!data?.impression?.length) return '';
  return data.impression
    .map(t => t.replace(/^\d+\.\s*/, '').replace(/^\[([^\]]+)\]:\s*/, '$1: '))
    .join(' ');
}

export function capFirst(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

// Single job now: explain the finding. What to do about it (see your
// doctor) is a separate, persistent card element rendered once — not
// repeated in every sentence, which read as alarming and discharge-
// paperwork-like when it was baked into every branch here.
export function patientFindingText(organ: string, measurements: ReportMeasurements): string {
  const organLabel = labelize(organRoot(organ)).toLowerCase();
  const loc = organLocation(organ);
  const subject =
    loc?.type === 'lateral' ? `your ${loc.word} ${organLabel}`
    : loc?.type === 'subregion' ? `the ${loc.word} of your ${organLabel}`
    : `your ${organLabel}`;
  const detail = measurements.section || '';

  if (!detail) {
    return `The scan flagged ${subject} for review — the report text wasn't specific enough to describe here.`;
  }

  const found = detectFindingTerm(detail);
  if (!found) {
    return `${capFirst(subject)} was flagged for review, but the report doesn't describe a specific spot or growth.`;
  }

  const sizeWord = sizeDescriptor(measurements.lesionVolumeCc ?? measurements.volumeCc, measurements.sizeCm);
  const sizePart = measurements.sizeCm ? ` measuring ${measurements.sizeCm} cm` : '';

  if (found.kind === 'descriptor') {
    return `The scan found that ${subject} is ${found.term}. ${found.definition}`;
  }

  const article = sizeWord ? `a ${sizeWord} ${found.term}` : `a ${found.term}`;
  const countPart = measurements.lesionCount > 1 ? `${measurements.lesionCount} ${found.term}s` : article;

  return `The scan found ${countPart}${sizePart} in ${subject}. ${found.definition}`;
}

/** Same >5cc-or-flagged filter ReportScreen uses to build its organ list. */
export function splitOrgans(data: ReportData | null): {
  all: [string, OrganData][];
  flagged: [string, OrganData][];
  normal: [string, OrganData][];
} {
  const all = data
    ? Object.entries(data.organ_volumes).filter(([, v]) => v.volume > 5 || v.status === 'check')
    : [];
  const flagged = all.filter(([, v]) => v.status === 'check');
  const normal = all.filter(([, v]) => v.status !== 'check');
  return { all, flagged, normal };
}
