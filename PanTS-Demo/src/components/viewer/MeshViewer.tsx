import { Bounds, OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { registerMeshRoot } from "../../helpers/viewer/meshCapture";
import { Suspense, useEffect, useMemo, useState } from "react";
import { APP_CONSTANTS } from "../../helpers/constants";
import { cornerstoneLpsMmToThree, type Vec3 } from "../../helpers/utils";
import type { MeshManifest } from "../../types";
import { OrganMesh } from "./OrganMesh";
import { SceneCrosshair3D } from "./SceneCrosshair3D";
import type { Color } from "@cornerstonejs/core/types";
import { LiveSegmentMesh } from "./LiveSegmentMesh";
import type { CheckBoxData } from "../../types";
import ErrorBoundary from "../ErrorBoundary";

type SegmentationMeshViewerProps = {
  caseId: string;
  loading: boolean
  checkState: boolean[];
  opacity: number;
  crosshairMm: Vec3 | null
  customOrgans?: CheckBoxData[];
  labelColorMap?: { [key: number]: Color };
  // Uploaded scans have no pre-baked meshes; fetch from the session route, which
  // builds them on demand from the session's combined_labels.
  isSession?: boolean;
};

export async function fetchMeshManifest(caseId: string, isSession = false): Promise<MeshManifest> {
  const base = isSession
    ? `${APP_CONSTANTS.API_ORIGIN}/api/sessions/${caseId}/mesh-manifest`
    : `${APP_CONSTANTS.API_ORIGIN}/api/cases/${caseId}/mesh-manifest`;
  const res = await fetch(base);
  if (!res.ok) throw new Error(`Failed to fetch mesh manifest: ${res.status}`);
  const data = await res.json() as Partial<MeshManifest>;
  if (!Array.isArray(data.organs) || !Array.isArray(data.center)) {
    throw new Error("Mesh manifest response is invalid");
  }
  return data as MeshManifest;
}

export function SegmentationMeshViewer({ caseId, checkState, loading, opacity, crosshairMm, customOrgans = [], labelColorMap = {}, isSession = false}: SegmentationMeshViewerProps) {
  const [manifest, setManifest] = useState<MeshManifest | null>(null);
  const [manifestError, setManifestError] = useState(false);
  const [loaded, setLoaded] = useState<Record<number, boolean>>({});

  // Drop the renderer handle when this pane goes away, so a capture can never
  // reach into a disposed WebGL context.
  useEffect(() => () => registerMeshRoot(null), []);

  const crosshairPosition = useMemo(() => {
    if (!manifest || !crosshairMm) return null;
    return cornerstoneLpsMmToThree(crosshairMm, manifest.center);
  }, [manifest, crosshairMm]);

  useEffect(() => {
    let alive = true;
    setManifest(null);
    setManifestError(false);
    fetchMeshManifest(caseId, isSession)
      .then((data) => {
        if (!alive) return;
        setManifest(data);
        const initialLoaded: Record<number, boolean> = {};
        for (const organ of data.organs) initialLoaded[organ.id] = true;
        setLoaded(initialLoaded);
      })
      .catch(() => { if (alive) setManifestError(true); });
    return () => { alive = false; };
  }, [caseId, isSession]);

  const organs = useMemo(() => manifest?.organs ?? [], [manifest]);

  if (manifestError) return <div role="alert">3D segmentation unavailable.</div>;
  if (!manifest || loading || !checkState || checkState.length === 0) {
    return <div>Loading 3D segmentation...</div>;
  }
  return (
    <div style={{ display: "flex", width: "100%", height: "100%" }}>
      <main style={{ flex: 1, minWidth: 0 }}>
        {/*
          preserveDrawingBuffer is REQUIRED for the AI assistant's snapshots.
          WebGL clears the drawing buffer as soon as the frame is composited, so
          without it canvas.toDataURL() reads an already-cleared buffer and the
          captured "3D view" is a black rectangle. data-bodymaps-3d marks the
          canvas so the capture helper picks this one and never an unrelated
          canvas that happens to sit in the same pane.
        */}
        <ErrorBoundary fallback={<div className="vp-3d-empty">3D segmentation unavailable.</div>}>
        <Canvas
          camera={{ position: [0, 250, 650], fov: 45, near: 0.1, far: 5000 }}
          gl={{ preserveDrawingBuffer: true, antialias: true }}
          frameloop="always"
          onCreated={(state) => {
            registerMeshRoot(state);
            state.gl.domElement.setAttribute("data-bodymaps-3d", "1");
          }}
        >
          <color attach="background" args={["#050505"]} />
          <ambientLight intensity={0.7} />
          <directionalLight position={[300, 500, 300]} intensity={1.2} />
          <Suspense fallback={null}>
            <Bounds fit clip observe margin={1.2}>
              <group>
                {organs.map((organ) => {
                  if (!loaded[organ.id]) return null;
                  // Always render the pre-baked GLB, even after this organ
                  // has been edited. Switching to a live marching-cubes
                  // mesh (LiveSegmentMesh) the instant an edit lands was
                  // both expensive (isosurface extraction on the stroke
                  // that triggers the switch — visible as a lag spike
                  // right on the first brush stroke) and unnecessary: the
                  // 3D pane is meant to show the original mesh, not a
                  // live reconstruction of in-progress annotations, so
                  // there's nothing gained by ever recomputing it here.
                  // Custom classes (no baked GLB to fall back to) still go
                  // through LiveSegmentMesh below, since that's the only
                  // way they can be shown in 3D at all.
                  return (
                    <OrganMesh
                      key={organ.id}
                      organ={organ}
                      visible={!!checkState[organ.id]}
                      opacity={opacity/100}
                      color={labelColorMap[organ.id]}
                    />
                  );
                })}
                {customOrgans.map((organ) => (
                  <LiveSegmentMesh
                    key={organ.id}
                    segmentIndex={organ.id}
                    color={labelColorMap[organ.id] ?? [255, 255, 255, 255]}
                    visible={!!checkState[organ.id]}
                    opacity={opacity / 100}
                    manifestCenter={manifest.center as [number, number, number]}
                  />
                ))}
              </group>
            </Bounds>
            {crosshairPosition && manifest.bounds && (
              <SceneCrosshair3D position={crosshairPosition} bounds={manifest.bounds} />
            )}
          </Suspense>
          <OrbitControls makeDefault />
        </Canvas>
        </ErrorBoundary>
      </main>
    </div>
  );
}