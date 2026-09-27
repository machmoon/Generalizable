import XCTest
import simd
@testable import Lumen

final class MeshTests: XCTestCase {
    private func sphereVolume(r: Float, n: Int32 = 48, spacing: SIMD3<Float> = [1, 1, 1],
                              label: Organ = .liver) -> LabelVolume {
        let g = VolumeGeometry(dims: [n, n, n], spacing: spacing, affine: matrix_identity_float4x4)
        var vox = [UInt8](repeating: 0, count: g.count)
        let c = SIMD3<Float>(repeating: Float(n) / 2)
        for z in 0..<Int(n) { for y in 0..<Int(n) { for x in 0..<Int(n) {
            let p = (SIMD3<Float>(Float(x), Float(y), Float(z)) + 0.5 - c) * spacing
            if simd_length(p) <= r { vox[g.index(x, y, z)] = label.rawValue }
        } } }
        return LabelVolume(geometry: g, voxels: vox)
    }

    func testSphere() throws {
        let lv = sphereVolume(r: 15)
        let boxes = SurfaceNets.boundingBoxes(lv)
        let box = try XCTUnwrap(boxes[Organ.liver.rawValue])
        let mesh = try XCTUnwrap(SurfaceNets.extract(lv, organ: .liver, box: box, factor: 1))
        XCTAssertGreaterThan(mesh.triangleCount, 500)
        // Radius close to 15 mm around the volume centre.
        let radii = mesh.positions.map { simd_length($0) }
        let mean = radii.reduce(0, +) / Float(radii.count)
        XCTAssertEqual(mean, 15, accuracy: 1.2)
        XCTAssertLessThan(radii.max()! - radii.min()!, 4)
        // Normals point outward.
        let outward = zip(mesh.positions, mesh.normals).filter { simd_dot($0, $1) > 0 }.count
        XCTAssertGreaterThan(Float(outward) / Float(mesh.positions.count), 0.98)
        // (Nearly) closed, consistently wound surface: almost every directed edge has its twin.
        var directed = Set<UInt64>()
        for t in stride(from: 0, to: mesh.indices.count, by: 3) {
            for k in 0..<3 {
                let a = UInt64(mesh.indices[t + k]), b = UInt64(mesh.indices[t + (k + 1) % 3])
                directed.insert(a << 32 | b)
            }
        }
        let unpaired = directed.filter { !directed.contains(($0 & 0xffff_ffff) << 32 | $0 >> 32) }.count
        XCTAssertLessThan(Float(unpaired) / Float(directed.count), 0.01)
    }

    func testDownsampleAndAnisotropicSpacing() throws {
        let lv = sphereVolume(r: 20, n: 64, spacing: [0.8, 0.8, 1.5])
        let box = try XCTUnwrap(SurfaceNets.boundingBoxes(lv)[Organ.liver.rawValue])
        let mesh = try XCTUnwrap(SurfaceNets.extract(lv, organ: .liver, box: box, factor: 2))
        let mean = mesh.positions.map { simd_length($0) }.reduce(0, +) / Float(mesh.positions.count)
        XCTAssertEqual(mean, 20, accuracy: 2)
    }

    func testSceneOrientation() {
        // +x canonical (patient Right) → scene -x; +y (Anterior) → scene +z; +z (Superior) → scene +y.
        let g = VolumeGeometry(dims: [10, 10, 10], spacing: [1, 1, 1], affine: matrix_identity_float4x4)
        let o = SurfaceNets.sceneFromVoxel([4.5, 4.5, 4.5], g)
        XCTAssertLessThan(simd_length(o), 1e-5)
        XCTAssertEqual(SurfaceNets.sceneFromVoxel([9.5, 4.5, 4.5], g).x, -5)
        XCTAssertEqual(SurfaceNets.sceneFromVoxel([4.5, 9.5, 4.5], g).z, 5)
        XCTAssertEqual(SurfaceNets.sceneFromVoxel([4.5, 4.5, 9.5], g).y, 5)
    }

    func testRealCaseIfLoaderAvailable() async throws {
        let dir = URL(fileURLWithPath: "/Users/patliu/BodyMaps-website/scans/PanTS_00008205")
        let info = CaseInfo(id: "PanTS_00008205", title: "8205",
                            ctURL: dir.appendingPathComponent("ct.nii.gz"),
                            labelURL: dir.appendingPathComponent("combined_labels.nii.gz"))
        guard let loaded = try? await VolumeLoader.load(info), let labels = loaded.labels else {
            throw XCTSkip("VolumeLoader not available yet")
        }
        let t0 = Date()
        let boxes = SurfaceNets.boundingBoxes(labels)
        var tris = 0
        for (k, b) in boxes {
            guard let o = Organ(rawValue: k) else { continue }
            let m = SurfaceNets.extract(labels, organ: o, box: b)
            tris += m?.triangleCount ?? 0
        }
        print("real case: \(boxes.count) labels, \(tris) triangles in \(Date().timeIntervalSince(t0))s")
        XCTAssertGreaterThan(tris, 10_000)
    }
}
