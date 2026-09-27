// 3D organ-surface pane (SceneKit). Meshes come from Meshing/SurfaceNets.swift via
// MeshCache (streamed per organ as each background task finishes).
//
// Scene space: +x patient Left, +y Superior, +z Anterior (mm, volume-centred); the
// default camera sits on +z, so the patient is upright and faces the viewer.
// Lesions render last, emissive and without depth testing, so they stay visible
// through (or behind) every other organ; other organs share an adjustable opacity.

import SwiftUI
import SceneKit
import simd

struct MeshView: View {
    @Bindable var state: ViewerState
    @State private var meshes: [Organ: OrganMesh] = [:]
    @State private var loading = false
    @State private var expected = 0
    @State private var focus: SIMD3<Float> = .zero
    @State private var opacity: Float = 0.9
    @State private var showPlane = true
    @State private var resetToken = 0

    var body: some View {
        ZStack {
            MeshSceneView(meshes: meshes,
                          visible: state.visibleOrgans,
                          selected: state.selectedOrgan,
                          opacity: opacity,
                          cursorScene: SurfaceNets.sceneFromVoxel(state.cursor, state.geometry),
                          extent: state.geometry.extentMM,
                          showPlane: showPlane,
                          focus: focus,
                          resetToken: resetToken,
                          onSelect: { organ in
                              state.selectedOrgan = (organ == state.selectedOrgan) ? nil : organ
                          })
            .ignoresSafeArea()

            if state.loaded.labels == nil {
                Text("No segmentation for this case").font(.callout).foregroundStyle(.secondary)
            }

            VStack(spacing: 8) {
                HStack(alignment: .top) {
                    if loading {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.mini)
                            Text("Meshing \(meshes.count)/\(max(expected, meshes.count))")
                        }
                        .font(.caption2.monospacedDigit())
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(.ultraThinMaterial, in: Capsule())
                    }
                    Spacer()
                    if let s = state.selectedOrgan {
                        Button { state.selectedOrgan = nil } label: {
                            HStack(spacing: 6) {
                                Circle().fill(s.color).frame(width: 8, height: 8)
                                Text(s.displayName)
                                Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                            }
                            .font(.caption)
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .background(.ultraThinMaterial, in: Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
                Spacer()
                HStack(spacing: 10) {
                    Image(systemName: "circle.lefthalf.filled").font(.caption)
                    Slider(value: $opacity, in: 0.08...1).frame(maxWidth: 160)
                    Button { showPlane.toggle() } label: {
                        Image(systemName: showPlane ? "square.split.1x2.fill" : "square.split.1x2")
                    }
                    Button { resetToken += 1 } label: { Image(systemName: "scope") }
                }
                .font(.callout)
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(.ultraThinMaterial, in: Capsule())
            }
            .padding(10)
        }
        .background(Color(white: 0.05))
        .task(id: state.loaded.info.id) { await load() }
    }

    private func load() async {
        let loaded = state.loaded
        guard loaded.labels != nil else { return }
        let id = loaded.info.id
        if let e = MeshCache.shared.entry(id), e.complete {
            meshes = e.meshes
            if let b = e.boxes { focus = MeshCache.focus(of: b, loaded.ct.geometry) }
            return
        }
        loading = true
        meshes = [:]
        for await m in MeshCache.shared.meshes(for: loaded) {
            if meshes.isEmpty, let b = MeshCache.shared.entry(id)?.boxes {
                focus = MeshCache.focus(of: b, loaded.ct.geometry)
                expected = b.keys.filter { Organ(rawValue: $0) != nil }.count
            }
            meshes[m.organ] = m
        }
        loading = false
    }
}

// MARK: - SceneKit bridge

private struct MeshSceneView: UIViewRepresentable {
    var meshes: [Organ: OrganMesh]
    var visible: Set<Organ>
    var selected: Organ?
    var opacity: Float
    var cursorScene: SIMD3<Float>
    var extent: SIMD3<Float>
    var showPlane: Bool
    var focus: SIMD3<Float>
    var resetToken: Int
    var onSelect: (Organ?) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> SCNView {
        let v = SCNView(frame: .zero)
        v.scene = context.coordinator.scene
        v.backgroundColor = UIColor(white: 0.05, alpha: 1)
        v.antialiasingMode = .multisampling4X
        v.allowsCameraControl = true
        v.autoenablesDefaultLighting = false
        v.rendersContinuously = false
        v.defaultCameraController.interactionMode = .orbitTurntable
        v.defaultCameraController.worldUp = SCNVector3(0, 1, 0)
        v.defaultCameraController.inertiaEnabled = true
        v.pointOfView = context.coordinator.cameraNode
        context.coordinator.view = v
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:)))
        v.addGestureRecognizer(tap)
        return v
    }

    func updateUIView(_ v: SCNView, context: Context) {
        let c = context.coordinator
        c.onSelect = onSelect
        c.sync(self)
    }

    final class Coordinator: NSObject {
        let scene = SCNScene()
        let cameraNode = SCNNode()
        let organRoot = SCNNode()
        let cursorNode = SCNNode()
        let planeNode = SCNNode()
        weak var view: SCNView?
        var nodes: [Organ: SCNNode] = [:]
        var onSelect: ((Organ?) -> Void)?
        var lastFocus: SIMD3<Float>?
        var lastReset = 0
        var lastExtent: SIMD3<Float> = .zero

        override init() {
            super.init()
            let cam = SCNCamera()
            cam.fieldOfView = 35
            cam.zNear = 1
            cam.zFar = 10_000
            cam.wantsHDR = false
            cameraNode.camera = cam
            // Key light rides with the camera (as in most clinical 3D viewers), plus fill.
            let key = SCNLight(); key.type = .directional; key.intensity = 900
            let keyNode = SCNNode(); keyNode.light = key
            keyNode.eulerAngles = SCNVector3(-0.35, -0.3, 0)
            cameraNode.addChildNode(keyNode)
            let amb = SCNLight(); amb.type = .ambient; amb.intensity = 350
            amb.color = UIColor(white: 0.9, alpha: 1)
            let ambNode = SCNNode(); ambNode.light = amb
            scene.rootNode.addChildNode(ambNode)
            scene.rootNode.addChildNode(cameraNode)
            scene.rootNode.addChildNode(organRoot)

            let sphere = SCNSphere(radius: 3.5)
            let sm = SCNMaterial()
            sm.lightingModel = .constant
            sm.diffuse.contents = UIColor(red: 1, green: 0.85, blue: 0.1, alpha: 1)
            sm.readsFromDepthBuffer = false
            sphere.materials = [sm]
            cursorNode.geometry = sphere
            cursorNode.renderingOrder = 200
            cursorNode.name = "cursor"
            scene.rootNode.addChildNode(cursorNode)

            planeNode.name = "plane"
            planeNode.renderingOrder = 50
            planeNode.eulerAngles.x = -.pi / 2  // SCNPlane is in xy; lay it in xz (axial)
            scene.rootNode.addChildNode(planeNode)
        }

        func resetCamera(extent: SIMD3<Float>, focus: SIMD3<Float>) {
            let dist = max(extent.x, extent.y, extent.z) * 1.7 + 50
            cameraNode.simdPosition = focus + SIMD3<Float>(0, 0, dist)
            cameraNode.simdOrientation = simd_quatf(angle: 0, axis: [0, 1, 0])
            view?.pointOfView = cameraNode
            view?.defaultCameraController.target = SCNVector3(focus.x, focus.y, focus.z)
        }

        func sync(_ p: MeshSceneView) {
            if p.extent != lastExtent {
                lastExtent = p.extent
                let plane = SCNPlane(width: CGFloat(p.extent.x), height: CGFloat(p.extent.y))
                let pm = SCNMaterial()
                pm.lightingModel = .constant
                pm.diffuse.contents = UIColor(red: 0.35, green: 0.75, blue: 1, alpha: 1)
                pm.transparency = 0.12
                pm.isDoubleSided = true
                pm.writesToDepthBuffer = false
                plane.materials = [pm]
                planeNode.geometry = plane
            }
            if lastFocus != p.focus || lastReset != p.resetToken {
                lastFocus = p.focus; lastReset = p.resetToken
                resetCamera(extent: p.extent, focus: p.focus)
            }

            for (organ, mesh) in p.meshes where nodes[organ] == nil {
                let n = SCNNode(geometry: Self.geometry(mesh))
                n.name = "organ:\(organ.rawValue)"
                organRoot.addChildNode(n)
                nodes[organ] = n
            }
            for (organ, n) in nodes where p.meshes[organ] == nil {
                n.removeFromParentNode(); nodes[organ] = nil
            }
            for (organ, n) in nodes {
                n.isHidden = !p.visible.contains(organ)
                style(n, organ: organ, selected: p.selected, opacity: p.opacity)
            }

            cursorNode.simdPosition = p.cursorScene
            planeNode.isHidden = !p.showPlane
            planeNode.simdPosition = SIMD3<Float>(0, p.cursorScene.y, 0)
        }

        private func style(_ n: SCNNode, organ: Organ, selected: Organ?, opacity: Float) {
            guard let m = n.geometry?.firstMaterial else { return }
            let base = UIColor(organ.color)
            m.diffuse.contents = base
            let isSel = selected == organ
            let dimmed = selected != nil && !isSel
            var alpha: CGFloat
            if organ.isLesion {
                alpha = dimmed ? 0.55 : 1
                m.emission.contents = base.withAlphaComponent(1).multiplied(isSel ? 0.7 : 0.45)
                m.readsFromDepthBuffer = false   // always visible through other organs
                n.renderingOrder = isSel ? 120 : 100
            } else {
                alpha = isSel ? 1 : (dimmed ? CGFloat(min(opacity, 0.18)) : CGFloat(opacity))
                m.emission.contents = isSel ? base.multiplied(0.25) : UIColor.black
                m.readsFromDepthBuffer = true
                n.renderingOrder = alpha < 0.999 ? 10 : 0
            }
            m.transparency = alpha
            m.writesToDepthBuffer = alpha >= 0.999
            m.blendMode = .alpha
        }

        static func geometry(_ mesh: OrganMesh) -> SCNGeometry {
            let stride = MemoryLayout<SIMD3<Float>>.stride
            let vData = mesh.positions.withUnsafeBufferPointer { Data(buffer: $0) }
            let nData = mesh.normals.withUnsafeBufferPointer { Data(buffer: $0) }
            let vs = SCNGeometrySource(data: vData, semantic: .vertex, vectorCount: mesh.positions.count,
                                       usesFloatComponents: true, componentsPerVector: 3,
                                       bytesPerComponent: 4, dataOffset: 0, dataStride: stride)
            let ns = SCNGeometrySource(data: nData, semantic: .normal, vectorCount: mesh.normals.count,
                                       usesFloatComponents: true, componentsPerVector: 3,
                                       bytesPerComponent: 4, dataOffset: 0, dataStride: stride)
            let iData = mesh.indices.withUnsafeBufferPointer { Data(buffer: $0) }
            let el = SCNGeometryElement(data: iData, primitiveType: .triangles,
                                        primitiveCount: mesh.triangleCount, bytesPerIndex: 4)
            let g = SCNGeometry(sources: [vs, ns], elements: [el])
            let m = SCNMaterial()
            m.lightingModel = .blinn
            m.specular.contents = UIColor(white: 0.45, alpha: 1)
            m.shininess = 0.35
            m.fresnelExponent = 1.5
            m.transparencyMode = .dualLayer
            m.isDoubleSided = false
            g.materials = [m]
            return g
        }

        @objc func tapped(_ gr: UITapGestureRecognizer) {
            guard let v = view else { return }
            let hits = v.hitTest(gr.location(in: v), options: [
                .searchMode: SCNHitTestSearchMode.all.rawValue,
                .ignoreHiddenNodes: true,
            ])
            let organs: [Organ] = hits.compactMap { h in
                guard let name = h.node.name, name.hasPrefix("organ:"),
                      let raw = UInt8(name.dropFirst(6)) else { return nil }
                return Organ(rawValue: raw)
            }
            // Lesions are drawn on top, so they win the tap when under the finger.
            onSelect?(organs.first(where: \.isLesion) ?? organs.first)
        }
    }
}

private extension UIColor {
    func multiplied(_ k: CGFloat) -> UIColor {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        getRed(&r, green: &g, blue: &b, alpha: &a)
        return UIColor(red: r * k, green: g * k, blue: b * k, alpha: 1)
    }
}
