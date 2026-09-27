// VolumeLoader — NIfTI-1 (.nii / .nii.gz) → canonical RAS+ CTVolume / LabelVolume.
// Owned by agent io.
//
// Prior art (read before writing this file):
// - nibabel/orientations.py (github.com/nipy/nibabel, master):
//   `io_orientation` — per input axis, pick the world axis with the largest |R| after
//   column-normalising the affine, processing input axes from strongest to weakest and
//   removing each chosen output axis (greedy, tie-stable). `inv_ornt_aff` — the
//   flip-then-transpose affine fix. `as_closest_canonical` (nibabel/funcs.py) applies it.
//   Deviation: nibabel runs a polar decomposition (SVD) to remove shear first; we skip
//   it because scanner affines have no shear and the greedy argmax is identical then.
// - nifti1.h (NIfTI DFWG) for the 348-byte header layout, qform quaternion→matrix
//   (nifti_quatern_to_mat44) and "sform if sform_code>0 else qform else pixdim".
//
// Performance: the file is read with mmap, gzip is inflated with Apple's Compression
// framework (COMPRESSION_ZLIB = raw deflate, so we skip the gzip member header ourselves)
// streaming straight into the final buffer; CT and labels decode concurrently; the
// reorientation copy is parallelised over output z-slices.

import Foundation
import Compression
import simd

enum VolumeLoaderError: LocalizedError {
    case missingCT
    case notNIfTI(String)
    case unsupportedDatatype(Int16)
    case bigEndian
    case gzip(String)
    case truncated
    case shapeMismatch

    var errorDescription: String? {
        switch self {
        case .missingCT: "This case has no CT file on the device."
        case .notNIfTI(let s): "Not a NIfTI-1 file (\(s))."
        case .unsupportedDatatype(let d): "Unsupported NIfTI datatype \(d)."
        case .bigEndian: "Big-endian NIfTI files are not supported."
        case .gzip(let s): "Could not decompress: \(s)."
        case .truncated: "The file is truncated."
        case .shapeMismatch: "Label volume does not match the CT grid."
        }
    }
}

// MARK: - Header

struct NIfTIHeader: Sendable {
    var dims: SIMD3<Int>          // dim[1...3]
    var datatype: Int16
    var bitpix: Int16
    var pixdim: SIMD3<Float>      // pixdim[1...3]
    var qfac: Float               // pixdim[0]
    var voxOffset: Int
    var sclSlope: Float
    var sclInter: Float
    var qformCode: Int16
    var sformCode: Int16
    var quatern: SIMD3<Float>     // b, c, d
    var qoffset: SIMD3<Float>
    var srow: (SIMD4<Float>, SIMD4<Float>, SIMD4<Float>)

    var bytesPerVoxel: Int { Int(bitpix) / 8 }
    var voxelCount: Int { dims.x * dims.y * dims.z }

    static func parse(_ p: UnsafeRawBufferPointer) throws -> NIfTIHeader {
        guard p.count >= 348 else { throw VolumeLoaderError.truncated }
        func i16(_ o: Int) -> Int16 { p.loadUnaligned(fromByteOffset: o, as: Int16.self) }
        func f32(_ o: Int) -> Float { p.loadUnaligned(fromByteOffset: o, as: Float.self) }
        let sizeof = p.loadUnaligned(fromByteOffset: 0, as: Int32.self)
        if sizeof != 348 {
            if sizeof.byteSwapped == 348 { throw VolumeLoaderError.bigEndian }
            throw VolumeLoaderError.notNIfTI("sizeof_hdr=\(sizeof)")
        }
        let ndim = Int(i16(40))
        var d = SIMD3<Int>(1, 1, 1)
        for k in 0..<3 where k < ndim { d[k] = max(1, Int(i16(42 + 2 * k))) }
        var pix = SIMD3<Float>(1, 1, 1)
        for k in 0..<3 { let v = abs(f32(80 + 4 * k)); pix[k] = (v > 0 && v.isFinite) ? v : 1 }
        var slope = f32(112), inter = f32(116)
        if slope == 0 || !slope.isFinite { slope = 1; inter = 0 }
        if !inter.isFinite { inter = 0 }
        let qf = f32(76)
        return NIfTIHeader(
            dims: d, datatype: i16(70), bitpix: i16(72), pixdim: pix,
            qfac: qf < 0 ? -1 : 1,
            voxOffset: max(348, Int(f32(108))),
            sclSlope: slope, sclInter: inter,
            qformCode: i16(252), sformCode: i16(254),
            quatern: SIMD3(f32(256), f32(260), f32(264)),
            qoffset: SIMD3(f32(268), f32(272), f32(276)),
            srow: (SIMD4(f32(280), f32(284), f32(288), f32(292)),
                   SIMD4(f32(296), f32(300), f32(304), f32(308)),
                   SIMD4(f32(312), f32(316), f32(320), f32(324))))
    }

    /// Voxel → world (RAS mm) affine as stored: sform if sform_code>0, else qform, else pixdim.
    var affine: simd_double4x4 {
        if sformCode > 0 {
            let r = [srow.0, srow.1, srow.2].map { SIMD4<Double>($0) }
            return simd_double4x4(rows: [r[0], r[1], r[2], SIMD4(0, 0, 0, 1)])
        }
        if qformCode > 0 {
            // nifti_quatern_to_mat44
            var b = Double(quatern.x), c = Double(quatern.y), d = Double(quatern.z)
            var a = 1 - (b * b + c * c + d * d)
            if a < 1e-7 { a = 1 / (b * b + c * c + d * d).squareRoot(); b *= a; c *= a; d *= a; a = 0 }
            else { a = a.squareRoot() }
            let xd = Double(pixdim.x), yd = Double(pixdim.y), zd = Double(pixdim.z) * Double(qfac)
            let r0 = SIMD4<Double>((a*a+b*b-c*c-d*d) * xd, 2*(b*c-a*d) * yd, 2*(b*d+a*c) * zd, Double(qoffset.x))
            let r1 = SIMD4<Double>(2*(b*c+a*d) * xd, (a*a+c*c-b*b-d*d) * yd, 2*(c*d-a*b) * zd, Double(qoffset.y))
            let r2 = SIMD4<Double>(2*(b*d-a*c) * xd, 2*(c*d+a*b) * yd, (a*a+d*d-c*c-b*b) * zd, Double(qoffset.z))
            return simd_double4x4(rows: [r0, r1, r2, SIMD4(0, 0, 0, 1)])
        }
        return simd_double4x4(diagonal: SIMD4(Double(pixdim.x), Double(pixdim.y), Double(pixdim.z), 1))
    }
}

// MARK: - Orientation (nibabel io_orientation / inv_ornt_aff)

struct Orientation: Equatable, Sendable {
    /// For each canonical output axis j: the source axis and whether it is flipped.
    var sourceAxis: SIMD3<Int>
    var flip: SIMD3<Int32>   // 1 = flipped

    var isIdentity: Bool { sourceAxis == SIMD3(0, 1, 2) && flip == SIMD3<Int32>(repeating: 0) }

    /// nibabel `io_orientation`: ornt[in_ax] = (out_ax, ±1). Returned inverted, per output axis.
    static func from(affine A: simd_double4x4) -> Orientation {
        // R = column-normalised 3x3 (R[row][col]).
        var R = [[Double]](repeating: [0, 0, 0], count: 3)
        for c in 0..<3 {
            let col = SIMD3<Double>(A[c][0], A[c][1], A[c][2])
            var n = simd_length(col); if n == 0 { n = 1 }
            for r in 0..<3 { R[r][c] = col[r] / n }
        }
        // Strongest input axes first: argsort(min(-(R**2), axis=0)), stable.
        let strength = (0..<3).map { c in (0..<3).map { -R[$0][c] * R[$0][c] }.min()! }
        let order = (0..<3).sorted { strength[$0] < strength[$1] || (strength[$0] == strength[$1] && $0 < $1) }
        var outForIn = [Int](repeating: -1, count: 3), signForIn = [Double](repeating: 1, count: 3)
        for inAx in order {
            let col = (0..<3).map { R[$0][inAx] }
            guard col.contains(where: { abs($0) > 1e-12 }) else { continue }
            var best = 0
            for r in 1..<3 where abs(col[r]) > abs(col[best]) { best = r }
            outForIn[inAx] = best; signForIn[inAx] = col[best] < 0 ? -1 : 1
            for c in 0..<3 { R[best][c] = 0 }
        }
        // Fill any degenerate axis with the unused output axis.
        for i in 0..<3 where outForIn[i] < 0 {
            outForIn[i] = (0..<3).first { !outForIn.contains($0) }!
        }
        var o = Orientation(sourceAxis: .zero, flip: .zero)
        for i in 0..<3 { o.sourceAxis[outForIn[i]] = i; o.flip[outForIn[i]] = signForIn[i] < 0 ? 1 : 0 }
        return o
    }

    func outputDims(_ d: SIMD3<Int>) -> SIMD3<Int> {
        SIMD3(d[sourceAxis.x], d[sourceAxis.y], d[sourceAxis.z])
    }

    /// Canonical index → world affine (= affine · inv_ornt_aff(ornt, shape)).
    func canonicalAffine(_ A: simd_double4x4, sourceDims d: SIMD3<Int>) -> simd_double4x4 {
        // Canonical voxel c maps to source voxel s where s[src_j] = flip ? n-1-c_j : c_j.
        var M = simd_double4x4(0)
        for j in 0..<3 {
            let a = sourceAxis[j]
            if flip[j] != 0 { M[j][a] = -1; M[3][a] += Double(d[a] - 1) } else { M[j][a] = 1 }
        }
        M[3][3] = 1
        return A * M
    }
}

// MARK: - Loader

enum VolumeLoader {
    /// Decode ct + labels (NIfTI, .nii or .nii.gz) into canonical RAS+ volumes.
    static func load(_ info: CaseInfo, progress: (@Sendable (Double) -> Void)? = nil) async throws -> LoadedCase {
        guard let ctURL = info.ctURL else { throw VolumeLoaderError.missingCT }
        let labelURL = info.labelURL.flatMap { FileManager.default.fileExists(atPath: $0.path) ? $0 : nil }
        let tracker = ProgressTracker(hasLabels: labelURL != nil, report: progress)

        async let ctTask = Task.detached(priority: .userInitiated) {
            try decode(ctURL, kind: .hu) { tracker.update(ct: $0) }
        }.value
        async let labelTask: DecodedVolume? = {
            guard let labelURL else { return nil }
            return try await Task.detached(priority: .userInitiated) {
                try decode(labelURL, kind: .label) { tracker.update(label: $0) }
            }.value
        }()
        let ct = try await ctTask
        let lab = try await labelTask

        guard case .hu(let huVoxels) = ct.data else { throw VolumeLoaderError.shapeMismatch }
        let ctVol = CTVolume(geometry: ct.geometry, voxels: huVoxels)
        var labelVol: LabelVolume?
        if let lab, case .label(let lv) = lab.data {
            if lab.geometry.dims == ct.geometry.dims {
                labelVol = LabelVolume(geometry: ct.geometry, voxels: lv)
            } else {
                throw VolumeLoaderError.shapeMismatch
            }
        }
        var outInfo = info
        let g = ct.geometry
        if outInfo.metadata["dims"] == nil {
            outInfo.metadata["dims"] = "\(g.dims.x)×\(g.dims.y)×\(g.dims.z)"
            outInfo.metadata["spacing"] = String(format: "%.2f×%.2f×%.2f mm", g.spacing.x, g.spacing.y, g.spacing.z)
        }
        progress?(1)
        return LoadedCase(info: outInfo, ct: ctVol, labels: labelVol)
    }

    // MARK: Internals

    enum Kind { case hu, label }
    enum Payload { case hu([Int16]), label([UInt8]) }
    struct DecodedVolume { let geometry: VolumeGeometry; let data: Payload; let header: NIfTIHeader; let orientation: Orientation }

    /// Decode one file fully. `progress` gets 0...1 for this file.
    static func decode(_ url: URL, kind: Kind, progress: (Double) -> Void = { _ in }) throws -> DecodedVolume {
        let raw = try Data(contentsOf: url, options: .alwaysMapped)
        let bytes: Data
        if raw.count >= 2 && raw[raw.startIndex] == 0x1f && raw[raw.startIndex + 1] == 0x8b {
            bytes = try gunzip(raw) { progress($0 * 0.8) }
        } else {
            bytes = raw
        }
        progress(0.8)
        return try bytes.withUnsafeBytes { (buf: UnsafeRawBufferPointer) -> DecodedVolume in
            let h = try NIfTIHeader.parse(buf)
            let n = h.voxelCount
            guard [2, 4, 8, 16, 64, 256, 512, 768].contains(h.datatype) else {
                throw VolumeLoaderError.unsupportedDatatype(h.datatype)
            }
            let bpv = datatypeSize(h.datatype)
            guard buf.count >= h.voxOffset + n * bpv else { throw VolumeLoaderError.truncated }
            let src = buf.baseAddress! + h.voxOffset
            let A = h.affine
            let ornt = Orientation.from(affine: A)
            let outDims = ornt.outputDims(h.dims)
            let cA = ornt.canonicalAffine(A, sourceDims: h.dims)
            var spacing = SIMD3<Float>(repeating: 1)
            for j in 0..<3 {
                let col = SIMD3<Double>(cA[j][0], cA[j][1], cA[j][2])
                let s = Float(simd_length(col)); spacing[j] = s > 0 ? s : h.pixdim[ornt.sourceAxis[j]]
            }
            let geometry = VolumeGeometry(dims: SIMD3<Int32>(truncatingIfNeeded: outDims), spacing: spacing,
                                          affine: simd_float4x4(SIMD4<Float>(cA.columns.0), SIMD4<Float>(cA.columns.1),
                                                                SIMD4<Float>(cA.columns.2), SIMD4<Float>(cA.columns.3)))
            switch kind {
            case .hu:
                let native = [Int16](unsafeUninitializedCapacity: n) { out, c in
                    convertToInt16(src, h, n, out.baseAddress!); c = n
                }
                progress(0.9)
                let out = ornt.isIdentity ? native : reorient(native, h.dims, ornt)
                return DecodedVolume(geometry: geometry, data: .hu(out), header: h, orientation: ornt)
            case .label:
                let native = [UInt8](unsafeUninitializedCapacity: n) { out, c in
                    convertToUInt8(src, h, n, out.baseAddress!); c = n
                }
                progress(0.9)
                let out = ornt.isIdentity ? native : reorient(native, h.dims, ornt)
                return DecodedVolume(geometry: geometry, data: .label(out), header: h, orientation: ornt)
            }
        }
    }

    static func datatypeSize(_ dt: Int16) -> Int {
        switch dt { case 2, 256: 1; case 4, 512: 2; case 8, 16, 768: 4; case 64: 8; default: 0 }
    }

    // MARK: gzip

    /// Inflate a gzip member with Compression (raw deflate) straight into the output buffer.
    static func gunzip(_ gz: Data, progress: (Double) -> Void) throws -> Data {
        try gz.withUnsafeBytes { (g: UnsafeRawBufferPointer) -> Data in
            let p = g.bindMemory(to: UInt8.self)
            guard p.count > 18, p[2] == 8 else { throw VolumeLoaderError.gzip("bad header") }
            let flg = p[3]
            var off = 10
            if flg & 4 != 0 { off += 2 + Int(p[off]) | (Int(p[off + 1]) << 8) }  // FEXTRA
            if flg & 8 != 0 { while off < p.count && p[off] != 0 { off += 1 }; off += 1 }   // FNAME
            if flg & 16 != 0 { while off < p.count && p[off] != 0 { off += 1 }; off += 1 }  // FCOMMENT
            if flg & 2 != 0 { off += 2 }                                                   // FHCRC
            guard off < p.count - 8 else { throw VolumeLoaderError.gzip("bad header") }
            // ISIZE (mod 2^32) as a capacity hint; grow if the stream is larger.
            let isize = Int(p[p.count - 4]) | Int(p[p.count - 3]) << 8 | Int(p[p.count - 2]) << 16 | Int(p[p.count - 1]) << 24
            let compressed = p.count - off - 8
            var capacity = max(isize, compressed * 2, 1 << 16)

            var out = UnsafeMutableRawPointer.allocate(byteCount: capacity, alignment: 16)
            var produced = 0
            var stream = compression_stream(dst_ptr: out.assumingMemoryBound(to: UInt8.self), dst_size: 0,
                                            src_ptr: p.baseAddress!, src_size: 0, state: nil)
            guard compression_stream_init(&stream, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK else {
                out.deallocate(); throw VolumeLoaderError.gzip("init")
            }
            defer { compression_stream_destroy(&stream) }
            stream.src_ptr = p.baseAddress! + off
            stream.src_size = compressed
            let chunk = 8 << 20
            var lastReport = 0
            while true {
                if produced == capacity {
                    capacity *= 2
                    let bigger = UnsafeMutableRawPointer.allocate(byteCount: capacity, alignment: 16)
                    bigger.copyMemory(from: out, byteCount: produced)
                    out.deallocate(); out = bigger
                }
                let room = min(chunk, capacity - produced)
                stream.dst_ptr = out.assumingMemoryBound(to: UInt8.self) + produced
                stream.dst_size = room
                let status = compression_stream_process(&stream, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
                produced += room - stream.dst_size
                if status == COMPRESSION_STATUS_END { break }
                if status == COMPRESSION_STATUS_ERROR { out.deallocate(); throw VolumeLoaderError.gzip("corrupt stream") }
                if room - stream.dst_size == 0 && stream.src_size == 0 { break }
                let consumed = compressed - stream.src_size
                if consumed - lastReport > compressed / 50 { lastReport = consumed; progress(Double(consumed) / Double(compressed)) }
            }
            progress(1)
            return Data(bytesNoCopy: out, count: produced, deallocator: .custom { p, _ in p.deallocate() })
        }
    }

    // MARK: Conversion (native order)

    @_optimize(speed)
    static func convertToInt16(_ src: UnsafeRawPointer, _ h: NIfTIHeader, _ n: Int, _ dst: UnsafeMutablePointer<Int16>) {
        let slope = Double(h.sclSlope), inter = Double(h.sclInter)
        let identity = slope == 1 && inter == 0
        if h.datatype == 4 && identity {
            dst.update(from: src.assumingMemoryBound(to: Int16.self), count: n)  // voxOffset is even in practice
            return
        }
        @inline(__always) func clamp(_ v: Double) -> Int16 {
            let r = (v * slope + inter).rounded()
            return r >= 32767 ? .max : (r <= -32768 ? .min : (r.isNaN ? 0 : Int16(r)))
        }
        convert(src, h.datatype, n) { i, v in dst[i] = clamp(v) }
    }

    @_optimize(speed)
    static func convertToUInt8(_ src: UnsafeRawPointer, _ h: NIfTIHeader, _ n: Int, _ dst: UnsafeMutablePointer<UInt8>) {
        let slope = Double(h.sclSlope), inter = Double(h.sclInter)
        if (h.datatype == 2 || h.datatype == 256) && slope == 1 && inter == 0 {
            dst.update(from: src.assumingMemoryBound(to: UInt8.self), count: n); return
        }
        if h.datatype == 4 && slope == 1 && inter == 0 {
            let s = src.assumingMemoryBound(to: Int16.self)
            DispatchQueue.concurrentPerform(iterations: 16) { part in
                let lo = n * part / 16, hi = n * (part + 1) / 16
                for i in lo..<hi { let v = s[i]; dst[i] = v < 0 ? 0 : (v > 255 ? 255 : UInt8(v)) }
            }
            return
        }
        convert(src, h.datatype, n) { i, v in
            let r = (v * slope + inter).rounded()
            dst[i] = r >= 255 ? 255 : (r <= 0 || r.isNaN ? 0 : UInt8(r))
        }
    }

    /// Generic slow-ish path: every supported datatype through Double.
    @_optimize(speed)
    static func convert(_ src: UnsafeRawPointer, _ dt: Int16, _ n: Int, _ put: (Int, Double) -> Void) {
        switch dt {
        case 2: let s = src.assumingMemoryBound(to: UInt8.self); for i in 0..<n { put(i, Double(s[i])) }
        case 256: let s = src.assumingMemoryBound(to: Int8.self); for i in 0..<n { put(i, Double(s[i])) }
        case 4: for i in 0..<n { put(i, Double(src.loadUnaligned(fromByteOffset: i * 2, as: Int16.self))) }
        case 512: for i in 0..<n { put(i, Double(src.loadUnaligned(fromByteOffset: i * 2, as: UInt16.self))) }
        case 8: for i in 0..<n { put(i, Double(src.loadUnaligned(fromByteOffset: i * 4, as: Int32.self))) }
        case 768: for i in 0..<n { put(i, Double(src.loadUnaligned(fromByteOffset: i * 4, as: UInt32.self))) }
        case 16: for i in 0..<n { put(i, Double(src.loadUnaligned(fromByteOffset: i * 4, as: Float.self))) }
        case 64: for i in 0..<n { put(i, src.loadUnaligned(fromByteOffset: i * 8, as: Double.self)) }
        default: break
        }
    }

    // MARK: Reorientation (flip + transpose, parallel over output z)

    @_optimize(speed)
    static func reorient(_ src: [Int16], _ d: SIMD3<Int>, _ o: Orientation) -> [Int16] {
        let (od, base, st) = plan(d, o)
        return [Int16](unsafeUninitializedCapacity: src.count) { out, c in
            src.withUnsafeBufferPointer { s in
                let sp = s.baseAddress!, dp = out.baseAddress!
                DispatchQueue.concurrentPerform(iterations: od.z) { z in
                    var dIdx = z * od.x * od.y
                    for y in 0..<od.y {
                        var sIdx = base + z * st.z + y * st.y
                        for _ in 0..<od.x { dp[dIdx] = sp[sIdx]; dIdx += 1; sIdx += st.x }
                    }
                }
            }
            c = src.count
        }
    }

    @_optimize(speed)
    static func reorient(_ src: [UInt8], _ d: SIMD3<Int>, _ o: Orientation) -> [UInt8] {
        let (od, base, st) = plan(d, o)
        return [UInt8](unsafeUninitializedCapacity: src.count) { out, c in
            src.withUnsafeBufferPointer { s in
                let sp = s.baseAddress!, dp = out.baseAddress!
                DispatchQueue.concurrentPerform(iterations: od.z) { z in
                    var dIdx = z * od.x * od.y
                    for y in 0..<od.y {
                        var sIdx = base + z * st.z + y * st.y
                        for _ in 0..<od.x { dp[dIdx] = sp[sIdx]; dIdx += 1; sIdx += st.x }
                    }
                }
            }
            c = src.count
        }
    }

    /// Output dims, source base offset and signed source stride per output axis.
    static func plan(_ d: SIMD3<Int>, _ o: Orientation) -> (SIMD3<Int>, Int, SIMD3<Int>) {
        let srcStride = SIMD3<Int>(1, d.x, d.x * d.y)
        var st = SIMD3<Int>.zero, base = 0
        for j in 0..<3 {
            let a = o.sourceAxis[j]
            if o.flip[j] != 0 { st[j] = -srcStride[a]; base += (d[a] - 1) * srcStride[a] } else { st[j] = srcStride[a] }
        }
        return (o.outputDims(d), base, st)
    }
}

/// Merges CT/label progress into one 0...1 value, weighted by rough decode cost.
private final class ProgressTracker: @unchecked Sendable {
    private let lock = NSLock()
    private var ct = 0.0, label = 0.0, last = -1.0
    private let hasLabels: Bool
    private let report: (@Sendable (Double) -> Void)?
    init(hasLabels: Bool, report: (@Sendable (Double) -> Void)?) { self.hasLabels = hasLabels; self.report = report }
    func update(ct v: Double) { lock.lock(); ct = v; emit() }
    func update(label v: Double) { lock.lock(); label = v; emit() }
    private func emit() {
        let total = hasLabels ? ct * 0.85 + label * 0.15 : ct
        let fire = total - last >= 0.01
        if fire { last = total }
        lock.unlock()
        if fire { report?(min(total, 0.99)) }
    }
}
