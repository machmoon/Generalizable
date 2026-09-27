// Shared GPU upload of a LoadedCase, used by both SliceRenderer and VolumeRenderer so a
// case is uploaded once. Owned by the integrator.
import Metal

final class VolumeTextures: @unchecked Sendable {
    static let device: MTLDevice = MTLCreateSystemDefaultDevice()!
    let ct: MTLTexture          // .r16Sint, 3D, HU
    let labels: MTLTexture?     // .r8Uint, 3D, Organ raw values
    let organLUT: MTLTexture    // .rgba8Unorm, 1D (256), BodyMaps colours; alpha = 0 for 0

    private static let lock = NSLock()
    nonisolated(unsafe) private static var cache: [String: VolumeTextures] = [:]

    static func shared(for c: LoadedCase) -> VolumeTextures {
        lock.lock(); defer { lock.unlock() }
        if let t = cache[c.info.id] { return t }
        let t = VolumeTextures(c)
        cache = [c.info.id: t]   // keep one case resident; volumes are large
        return t
    }

    private init(_ c: LoadedCase) {
        let dev = Self.device
        let g = c.ct.geometry
        ct = Self.make3D(dev, g, .r16Sint, bytesPerVoxel: 2) { c.ct.voxels.withUnsafeBytes { $0.baseAddress! } }
        labels = c.labels.map { l in Self.make3D(dev, g, .r8Uint, bytesPerVoxel: 1) { l.voxels.withUnsafeBytes { $0.baseAddress! } } }
        let d = MTLTextureDescriptor()
        d.textureType = .type1D; d.pixelFormat = .rgba8Unorm; d.width = 256; d.usage = .shaderRead
        organLUT = dev.makeTexture(descriptor: d)!
        var lut = [UInt8](repeating: 0, count: 256 * 4)
        for o in Organ.allCases { let i = Int(o.rawValue) * 4; lut[i] = o.rgba.x; lut[i+1] = o.rgba.y; lut[i+2] = o.rgba.z; lut[i+3] = 255 }
        organLUT.replace(region: MTLRegionMake1D(0, 256), mipmapLevel: 0, withBytes: lut, bytesPerRow: 256 * 4)
    }

    private static func make3D(_ dev: MTLDevice, _ g: VolumeGeometry, _ fmt: MTLPixelFormat, bytesPerVoxel: Int,
                               _ bytes: () -> UnsafeRawPointer) -> MTLTexture {
        let d = MTLTextureDescriptor()
        d.textureType = .type3D; d.pixelFormat = fmt
        d.width = Int(g.dims.x); d.height = Int(g.dims.y); d.depth = Int(g.dims.z)
        d.usage = .shaderRead; d.storageMode = .shared
        let t = dev.makeTexture(descriptor: d)!
        let row = Int(g.dims.x) * bytesPerVoxel
        t.replace(region: MTLRegionMake3D(0, 0, 0, d.width, d.height, d.depth), mipmapLevel: 0, slice: 0,
                  withBytes: bytes(), bytesPerRow: row, bytesPerImage: row * d.height)
        return t
    }
}
