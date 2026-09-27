export type FacetRow = { value: string | number; label?: string; count: number };
export type FacetData = {
  counts: Record<string, FacetRow[]>;
  unknown: Record<string, number>;
  total: number;
  datasetCounts: Record<string, number>;
};
