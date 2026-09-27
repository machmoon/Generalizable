import { useMemo, useRef } from "react";
import * as THREE from "three";
import type { Color } from "@cornerstonejs/core/types";
import { extractSegmentSurface, consumePreEditSegmentSnapshot } from "../../helpers/CornerstoneNifti2";

type LiveSegmentMeshProps = {
  segmentIndex: number;
  color: Color;
  visible: boolean;
  opacity: number;
  manifestCenter: [number, number, number];
};

// Client-side isosurface for a custom/edited class, built once from the
// labelmap voxels present the first time this segment switches into the
// "live" render path (see MeshViewer: a static organ moves from its baked
// GLB to this component the moment it picks up its first edit; a brand
// new custom class renders through here from the start). Positioned in
// the same Three.js scene space as the pre-baked organ GLBs (see
// extractSegmentSurface's transform comments).
//
// Deliberately NOT rebuilt on every segmentation edit — re-running marching
// cubes on every brush stroke was expensive enough to cause visible stutter
// in the 2D panes while the 3D pane was open. Instead the geometry is
// extracted once (via the useMemo below, keyed only on segmentIndex /
// manifestCenter, never on paint activity) and then just reused: the mesh
// keeps showing that snapshot for the rest of the annotation session
// instead of vanishing. Toggling the 3D pane off and back on (which
// remounts this component) or switching target picks up the latest edits.
export function LiveSegmentMesh({
  segmentIndex,
  color,
  visible,
  opacity,
  manifestCenter,
}: LiveSegmentMeshProps) {
  // Cache extraction results per segmentIndex so switching targets back and
  // forth within one mount doesn't blow away a mesh we already built, and so
  // a re-render triggered by an unrelated edit (bumping editVersion in the
  // parent) never re-triggers marching cubes for a segment we've already
  // captured.
  const cacheRef = useRef<Map<number, ReturnType<typeof extractSegmentSurface>>>(new Map());

  const surface = useMemo(() => {
    const cache = cacheRef.current;
    if (cache.has(segmentIndex)) return cache.get(segmentIndex) ?? null;
    // If a pre-edit baseline was captured for this segment (see
    // setActiveEditSegment / _capturePreEditSnapshotIfAbsent), build from
    // that instead of the current live labelmap — the live data already
    // includes the stroke that caused this component to mount, and we
    // don't want that first stroke baked into the "original" mesh.
    // This is a one-shot read: it's consumed here and won't be available
    // again, so a later remount (3D pane toggled off/on) correctly falls
    // through to the live labelmap and picks up everything painted so far.
    const preEditSnapshot = consumePreEditSegmentSnapshot(segmentIndex);
    const result = extractSegmentSurface(segmentIndex, manifestCenter, preEditSnapshot);
    cache.set(segmentIndex, result);
    return result;
    // Intentionally excludes anything that changes on every paint stroke
    // (e.g. an edit-version counter) — this must only re-run when the
    // target segment itself changes, not on every mask edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentIndex, manifestCenter]);

  const geometry = useMemo(() => {
    if (!surface) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(surface.positions, 3));
    geo.setIndex(new THREE.BufferAttribute(surface.indices, 1));
    geo.computeVertexNormals();
    return geo;
  }, [surface]);

  // Nothing painted yet for this class (extractSegmentSurface returns null
  // when the mask is empty) — nothing to show, but don't throw.
  if (!geometry) return null;

  const [r, g, b, a = 255] = color;

  return (
    <mesh geometry={geometry} visible={visible}>
      <meshStandardMaterial
        color={new THREE.Color(r / 255, g / 255, b / 255)}
        transparent
        opacity={opacity * (a / 255)}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}