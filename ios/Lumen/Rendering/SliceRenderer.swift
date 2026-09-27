// SliceRenderer — draws one MPR slice into an MTKView.
// Design follows NiiVue's 2D slice path (github.com/niivue/niivue,
// packages/niivue/src/shader-srcs.ts: `vertSliceMMShader` + `kFragSliceHead`): one quad
// per slice, slice index as a uniform, window + overlay blend in the fragment shader.
// The quad's corners are SliceViewport.voxelToView of the slice's voxel corners, so
// SwiftUI overlays and gestures use the identical mapping.
import Metal
import MetalKit
import simd

/// Everything the slice pass needs; Equatable so SwiftUI only redraws on change.
struct SliceParams: Equatable {
    var plane: Plane
    var slice: Int
    var viewport: SliceViewport
    var winLow: Float
    var winHigh: Float
    var labelOpacity: Float
    var showLabels: Bool
    var outline: Bool
    var selected: UInt8
    var mask: [UInt32]   // 8 words
}

private struct SliceUniforms {
    var winLow: Float, winHigh: Float, labelOpacity: Float, outline: Float
    var plane: Int32, slice: Int32, selected: Int32, hasLabels: Int32
    var mask: (UInt32, UInt32, UInt32, UInt32, UInt32, UInt32, UInt32, UInt32)
}

private struct SliceVertex { var position: SIMD2<Float>; var uv: SIMD2<Float> }

final class SliceRenderer: NSObject, MTKViewDelegate {
    static let device = VolumeTextures.device
    private static let pipeline: MTLRenderPipelineState? = {
        guard let lib = device.makeDefaultLibrary(),
              let vf = lib.makeFunction(name: "sliceVertex"),
              let ff = lib.makeFunction(name: "sliceFragment") else { return nil }
        let d = MTLRenderPipelineDescriptor()
        d.vertexFunction = vf; d.fragmentFunction = ff
        d.colorAttachments[0].pixelFormat = .bgra8Unorm
        return try? device.makeRenderPipelineState(descriptor: d)
    }()
    private let queue = device.makeCommandQueue()!
    private var dummyLabels: MTLTexture?

    var textures: VolumeTextures
    var geometry: VolumeGeometry
    var params: SliceParams?

    init(textures: VolumeTextures, geometry: VolumeGeometry) {
        self.textures = textures
        self.geometry = geometry
        super.init()
    }

    static func planeIndex(_ p: Plane) -> Int32 {
        switch p { case .axial: 0; case .coronal: 1; case .sagittal: 2 }
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) { view.setNeedsDisplay() }

    func draw(in view: MTKView) {
        guard let pso = Self.pipeline, let p = params,
              let rpd = view.currentRenderPassDescriptor, let drawable = view.currentDrawable,
              let cmd = queue.makeCommandBuffer() else { return }
        rpd.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
        rpd.colorAttachments[0].loadAction = .clear
        guard let enc = cmd.makeRenderCommandEncoder(descriptor: rpd) else { return }

        let g = geometry
        let vp = p.viewport
        let size = vp.viewSize
        if size.width > 0, size.height > 0 {
            let ua = p.plane.uAxis, va = p.plane.vAxis, na = p.plane.normalAxis
            let uMax = Float(g.dims[ua]), vMax = Float(g.dims[va])
            // Corner voxel coords: voxel edges are at index -0.5 and n-0.5.
            func corner(_ u: Float, _ v: Float) -> SliceVertex {
                var vox = SIMD3<Float>(repeating: Float(p.slice))
                vox[ua] = u - 0.5; vox[va] = v - 0.5; vox[na] = Float(p.slice)
                let pt = vp.voxelToView(vox, g)
                let ndc = SIMD2<Float>(Float(pt.x / size.width) * 2 - 1, 1 - Float(pt.y / size.height) * 2)
                return SliceVertex(position: ndc, uv: SIMD2(u, v))
            }
            var verts = [corner(0, 0), corner(uMax, 0), corner(0, vMax), corner(uMax, vMax)]
            let m = p.mask + Array(repeating: 0, count: max(0, 8 - p.mask.count))
            var u = SliceUniforms(winLow: p.winLow, winHigh: p.winHigh, labelOpacity: p.labelOpacity,
                                  outline: p.outline ? 1 : 0, plane: Self.planeIndex(p.plane),
                                  slice: Int32(p.slice), selected: Int32(p.selected),
                                  hasLabels: (p.showLabels && textures.labels != nil) ? 1 : 0,
                                  mask: (m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7]))
            enc.setRenderPipelineState(pso)
            enc.setVertexBytes(&verts, length: MemoryLayout<SliceVertex>.stride * 4, index: 0)
            enc.setFragmentBytes(&u, length: MemoryLayout<SliceUniforms>.stride, index: 0)
            enc.setFragmentTexture(textures.ct, index: 0)
            enc.setFragmentTexture(textures.labels ?? dummyLabelTexture(), index: 1)
            enc.setFragmentTexture(textures.organLUT, index: 2)
            enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
        }
        enc.endEncoding()
        cmd.present(drawable)
        cmd.commit()
    }

    private func dummyLabelTexture() -> MTLTexture {
        if let t = dummyLabels { return t }
        let d = MTLTextureDescriptor()
        d.textureType = .type3D; d.pixelFormat = .r8Uint; d.width = 1; d.height = 1; d.depth = 1
        d.usage = .shaderRead
        let t = Self.device.makeTexture(descriptor: d)!
        dummyLabels = t
        return t
    }
}
