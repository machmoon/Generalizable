/**
 * Snapshot access to the 3D mesh pane's WebGL renderer.
 *
 * Reading a WebGL canvas from the outside — query the element, then call
 * toDataURL — is a race against the browser's compositor. `preserveDrawingBuffer`
 * narrows the window but does not close it: on some GPU/driver combinations the
 * buffer the read sees is the cleared one, which is what produced a solid black
 * "3D view" among the assistant's attached screenshots.
 *
 * Holding the renderer lets the capture draw a frame and read the pixels back in
 * the same synchronous block, where nothing can clear the buffer in between.
 *
 * This lives outside MeshViewer.tsx so that file exports only components (the
 * react-refresh lint rule), and so the capture path has no reason to import a
 * React component just to reach the renderer.
 */

import type { RootState } from "@react-three/fiber";

let meshRoot: RootState | null = null;

/** Called by the mesh viewer on mount, and with null when the pane unmounts. */
export function registerMeshRoot(state: RootState | null): void {
  meshRoot = state;
}

/**
 * A PNG data URL of the current 3D view, or null when no mesh pane is mounted
 * (single-view layouts, a case whose meshes have not loaded) or the readback
 * fails. Callers should fall back to their own canvas lookup on null.
 */
export function captureMeshCanvas(): string | null {
  if (!meshRoot) return null;
  try {
    const { gl, scene, camera } = meshRoot;
    gl.render(scene, camera);
    return gl.domElement.toDataURL("image/png");
  } catch (error) {
    console.warn("[BodyMaps AI] 3D readback failed", error);
    return null;
  }
}
