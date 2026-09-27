// Per-organ surface extraction for the 3D pane.
//
// Algorithm: naive Surface Nets on a binary mask, ported from Mikola Lysenko's
// github.com/mikolalysenko/isosurface  lib/surfacenets.js  (MIT; based on S. Gibson,
// "Constrained Elastic Surface Nets", MERL TR 1998). Same structure as that file:
//   - `cubeEdges` / `edgeTable` precomputed exactly as Lysenko builds them (corner g =
//     i + 2j + 4k; 12 edges; 256-entry crossing mask),
//   - one vertex per boundary cell at the mean of its edge crossings,
//   - one quad per sign-changing grid edge, joining the 4 cells around that edge.
// Deviations (stated): the field is a binary mask so crossings sit at edge midpoints
// (no interpolation), which makes the raw mesh terraced; we therefore follow it with
// Taubin λ|μ smoothing (Taubin 1995, the same non-shrinking filter VTK's
// vtkWindowedSincPolyDataFilter approximates and vtkSurfaceNets3D applies to label maps).
// Quad winding is chosen per-quad from the known inside→outside direction instead of
// Lysenko's parity trick, which is easier to verify.
//
// Output space ("scene space", SceneKit y-up): millimetres, centred on the volume
// centre, with +x = patient Left, +y = Superior, +z = Anterior. That is a proper
// rotation of RAS (det +1), so the camera on +z sees the patient upright, face-on,
// with the patient's right on screen-left (radiological convention).

import Foundation
import simd

struct OrganMesh: Sendable {
    let organ: Organ
    var positions: [SIMD3<Float>]
    var normals: [SIMD3<Float>]
    var indices: [UInt32]
    var triangleCount: Int { indices.count / 3 }
}

/// Inclusive voxel bounding box of one label.
struct LabelBox: Sendable, Equatable {
    var lo: SIMD3<Int32>
    var hi: SIMD3<Int32>
    var voxelCount: Int
    var size: SIMD3<Int32> { hi &- lo &+ 1 }
}

enum SurfaceNets {
    // MARK: tables (lib/surfacenets.js, lines 13-42)
    static let cubeEdges: [Int] = {
        var e: [Int] = []
        for i in 0..<8 {
            var j = 1
            while j <= 4 { let p = i ^ j; if i <= p { e.append(i); e.append(p) }; j <<= 1 }
        }
        return e
    }()
    static let edgeTable: [Int] = (0..<256).map { i in
        var em = 0
        for j in stride(from: 0, to: 24, by: 2) {
            let a = (i >> cubeEdges[j]) & 1, b = (i >> cubeEdges[j + 1]) & 1
            if a != b { em |= 1 << (j >> 1) }
        }
        return em
    }

    // MARK: geometry helpers

    /// Canonical voxel coordinate (float) → scene space (see header).
    static func sceneFromVoxel(_ v: SIMD3<Float>, _ g: VolumeGeometry) -> SIMD3<Float> {
        let mm = (v + 0.5) * g.spacing - g.extentMM / 2
        return SIMD3<Float>(-mm.x, mm.z, mm.y)
    }

    /// One pass over the label volume: bounding box + voxel count per label value.
    static func boundingBoxes(_ labels: LabelVolume) -> [UInt8: LabelBox] {
        let d = labels.geometry.dims
        let nx = Int(d.x), ny = Int(d.y), nz = Int(d.z)
        var lo = [SIMD3<Int32>](repeating: SIMD3(Int32.max, Int32.max, Int32.max), count: 256)
        var hi = [SIMD3<Int32>](repeating: SIMD3(-1, -1, -1), count: 256)
        var cnt = [Int](repeating: 0, count: 256)
        labels.voxels.withUnsafeBufferPointer { buf in
            var idx = 0
            for z in 0..<nz {
                for y in 0..<ny {
                    // Row min/max per label (cheap: rows are short, labels sparse).
                    for x in 0..<nx {
                        let v = Int(buf[idx]); idx += 1
                        if v == 0 { continue }
                        cnt[v] += 1
                        let p = SIMD3<Int32>(Int32(x), Int32(y), Int32(z))
                        lo[v] = pointwiseMin(lo[v], p)
                        hi[v] = pointwiseMax(hi[v], p)
                    }
                }
            }
        }
        var out: [UInt8: LabelBox] = [:]
        for v in 1..<256 where cnt[v] > 0 {
            out[UInt8(v)] = LabelBox(lo: lo[v], hi: hi[v], voxelCount: cnt[v])
        }
        return out
    }

    /// Default downsampling: 2× when the organ's bounding box is large.
    static func defaultFactor(for box: LabelBox) -> Int {
        let s = box.size
        return Int(s.x) * Int(s.y) * Int(s.z) > 2_000_000 ? 2 : 1
    }

    // MARK: extraction

    static func extract(_ labels: LabelVolume, organ: Organ, box: LabelBox,
                        factor: Int? = nil, smoothIterations: Int = 12) -> OrganMesh? {
        let g = labels.geometry
        let f = max(1, factor ?? defaultFactor(for: box))
        let label = organ.rawValue
        let bs = box.size
        // Sample grid with one sample of empty padding on every side.
        let nx = (Int(bs.x) + f - 1) / f + 2
        let ny = (Int(bs.y) + f - 1) / f + 2
        let nz = (Int(bs.z) + f - 1) / f + 2
        let sxy = nx * ny
        var mask = [UInt8](repeating: 0, count: nx * ny * nz)

        // 1. Binary mask (block-majority when downsampling).
        let vx = Int(g.dims.x), vxy = Int(g.dims.x) * Int(g.dims.y)
        let lo = SIMD3<Int>(truncatingIfNeeded: box.lo), hi = SIMD3<Int>(truncatingIfNeeded: box.hi)
        labels.voxels.withUnsafeBufferPointer { src in
            mask.withUnsafeMutableBufferPointer { m in
                for z in lo.z...hi.z {
                    let k = (z - lo.z) / f + 1
                    for y in lo.y...hi.y {
                        let j = (y - lo.y) / f + 1
                        let row = z * vxy + y * vx
                        let mrow = k * sxy + j * nx + 1
                        for x in lo.x...hi.x where src[row + x] == label {
                            m[mrow + (x - lo.x) / f] &+= 1
                        }
                    }
                }
                if f > 1 {
                    let thresh = UInt8(max(1, (f * f * f) / 2))
                    for i in 0..<m.count { m[i] = m[i] >= thresh ? 1 : 0 }
                } else {
                    for i in 0..<m.count where m[i] > 0 { m[i] = 1 }
                }
            }
        }

        // 2. One vertex per boundary cell (lib/surfacenets.js, lines 90-160).
        let cx = nx - 1, cy = ny - 1, cz = nz - 1
        let cxy = cx * cy
        var cellVertex = [Int32](repeating: -1, count: cx * cy * cz)
        var verts: [SIMD3<Float>] = []
        verts.reserveCapacity(4096)
        let ce = cubeEdges, et = edgeTable
        mask.withUnsafeBufferPointer { m in
            cellVertex.withUnsafeMutableBufferPointer { cv in
                for k in 0..<cz {
                    for j in 0..<cy {
                        for i in 0..<cx {
                            let base = i + j * nx + k * sxy
                            var bits = 0
                            bits |= Int(m[base])
                            bits |= Int(m[base + 1]) << 1
                            bits |= Int(m[base + nx]) << 2
                            bits |= Int(m[base + nx + 1]) << 3
                            bits |= Int(m[base + sxy]) << 4
                            bits |= Int(m[base + sxy + 1]) << 5
                            bits |= Int(m[base + sxy + nx]) << 6
                            bits |= Int(m[base + sxy + nx + 1]) << 7
                            if bits == 0 || bits == 0xff { continue }
                            let em = et[bits]
                            var v = SIMD3<Float>(0, 0, 0)
                            var n: Float = 0
                            for e in 0..<12 where em & (1 << e) != 0 {
                                let a = ce[2 * e], b = ce[2 * e + 1]
                                // Binary field: crossing at the edge midpoint.
                                v += SIMD3<Float>(Float(a & 1) + Float(b & 1),
                                                  Float((a >> 1) & 1) + Float((b >> 1) & 1),
                                                  Float((a >> 2) & 1) + Float((b >> 2) & 1)) * 0.5
                                n += 1
                            }
                            cv[i + j * cx + k * cxy] = Int32(verts.count)
                            verts.append(SIMD3<Float>(Float(i), Float(j), Float(k)) + v / n)
                        }
                    }
                }
            }
        }
        guard !verts.isEmpty else { return nil }

        // 3. Quads for each sign-changing edge; winding from inside→outside direction.
        var quads: [SIMD4<UInt32>] = []
        quads.reserveCapacity(verts.count)
        mask.withUnsafeBufferPointer { m in
            cellVertex.withUnsafeBufferPointer { cv in
                @inline(__always) func c(_ i: Int, _ j: Int, _ k: Int) -> UInt32 {
                    UInt32(bitPattern: cv[i + j * cx + k * cxy])
                }
                func emit(_ q: SIMD4<UInt32>, _ dir: SIMD3<Float>) {
                    let p0 = verts[Int(q.x)], p1 = verts[Int(q.y)], p2 = verts[Int(q.z)], p3 = verts[Int(q.w)]
                    let nrm = simd_cross(p2 - p0, p3 - p1)
                    quads.append(simd_dot(nrm, dir) >= 0 ? q : SIMD4(q.w, q.z, q.y, q.x))
                }
                for k in 1..<(nz - 1) {
                    for j in 1..<(ny - 1) {
                        for i in 0..<(nx - 1) {
                            let s = i + j * nx + k * sxy
                            let a = m[s]
                            // x-edge (i,j,k)-(i+1,j,k): cells (i, j-1..j, k-1..k)
                            if a != m[s + 1] {
                                emit(SIMD4(c(i, j - 1, k - 1), c(i, j, k - 1), c(i, j, k), c(i, j - 1, k)),
                                     SIMD3<Float>(a == 1 ? 1 : -1, 0, 0))
                            }
                        }
                    }
                }
                for k in 1..<(nz - 1) {
                    for j in 0..<(ny - 1) {
                        for i in 1..<(nx - 1) {
                            let s = i + j * nx + k * sxy
                            let a = m[s]
                            if a != m[s + nx] {
                                emit(SIMD4(c(i - 1, j, k - 1), c(i, j, k - 1), c(i, j, k), c(i - 1, j, k)),
                                     SIMD3<Float>(0, a == 1 ? 1 : -1, 0))
                            }
                        }
                    }
                }
                for k in 0..<(nz - 1) {
                    for j in 1..<(ny - 1) {
                        for i in 1..<(nx - 1) {
                            let s = i + j * nx + k * sxy
                            let a = m[s]
                            if a != m[s + sxy] {
                                emit(SIMD4(c(i - 1, j - 1, k), c(i, j - 1, k), c(i, j, k), c(i - 1, j, k)),
                                     SIMD3<Float>(0, 0, a == 1 ? 1 : -1))
                            }
                        }
                    }
                }
            }
        }
        guard !quads.isEmpty else { return nil }

        // 4. Sample-grid coords → scene space (mm, centred, y-up).
        let loF = SIMD3<Float>(box.lo), ff = Float(f), half = (ff - 1) / 2
        var pos = verts.map { s in
            // Sample index s ↔ block starting at voxel lo + (s-1)*f; block centre + half.
            sceneFromVoxel(loF + (s - 1) * ff + half, g)
        }

        // 5. Taubin smoothing over quad-edge adjacency.
        if smoothIterations > 0 { taubin(&pos, quads: quads, iterations: smoothIterations) }

        // 6. Triangulate + area-weighted vertex normals.
        var idx: [UInt32] = []
        idx.reserveCapacity(quads.count * 6)
        for q in quads {
            // Split along the shorter diagonal for fewer slivers.
            if simd_distance_squared(pos[Int(q.x)], pos[Int(q.z)]) <= simd_distance_squared(pos[Int(q.y)], pos[Int(q.w)]) {
                idx += [q.x, q.y, q.z, q.x, q.z, q.w]
            } else {
                idx += [q.x, q.y, q.w, q.y, q.z, q.w]
            }
        }
        var nrm = [SIMD3<Float>](repeating: .zero, count: pos.count)
        for t in stride(from: 0, to: idx.count, by: 3) {
            let a = Int(idx[t]), b = Int(idx[t + 1]), c = Int(idx[t + 2])
            let n = simd_cross(pos[b] - pos[a], pos[c] - pos[a])
            nrm[a] += n; nrm[b] += n; nrm[c] += n
        }
        for i in 0..<nrm.count {
            let l = simd_length(nrm[i])
            nrm[i] = l > 1e-12 ? nrm[i] / l : SIMD3<Float>(0, 1, 0)
        }
        return OrganMesh(organ: organ, positions: pos, normals: nrm, indices: idx)
    }

    /// Taubin λ|μ umbrella smoothing (λ = 0.5, μ = -0.53), `iterations` λ/μ pairs.
    static func taubin(_ pos: inout [SIMD3<Float>], quads: [SIMD4<UInt32>], iterations: Int) {
        let n = pos.count
        var deg = [Int32](repeating: 0, count: n + 1)
        for q in quads { deg[Int(q.x)] += 2; deg[Int(q.y)] += 2; deg[Int(q.z)] += 2; deg[Int(q.w)] += 2 }
        var start = [Int](repeating: 0, count: n + 1)
        for i in 0..<n { start[i + 1] = start[i] + Int(deg[i]) }
        var fill = start
        var nb = [UInt32](repeating: 0, count: start[n])
        for q in quads {
            let e = [q.x, q.y, q.z, q.w]
            for t in 0..<4 {
                let a = Int(e[t]), b = Int(e[(t + 1) & 3])
                nb[fill[a]] = UInt32(b); fill[a] += 1
                nb[fill[b]] = UInt32(a); fill[b] += 1
            }
        }
        var tmp = pos
        func pass(_ w: Float) {
            pos.withUnsafeBufferPointer { p in
                tmp.withUnsafeMutableBufferPointer { o in
                    nb.withUnsafeBufferPointer { nbp in
                        for i in 0..<n {
                            let s = start[i], e = start[i + 1]
                            if e == s { o[i] = p[i]; continue }
                            var acc = SIMD3<Float>(0, 0, 0)
                            for k in s..<e { acc += p[Int(nbp[k])] }
                            let mean = acc / Float(e - s)
                            o[i] = p[i] + w * (mean - p[i])
                        }
                    }
                }
            }
            swap(&pos, &tmp)
        }
        for _ in 0..<iterations { pass(0.5); pass(-0.53) }
    }
}
