import XCTest
import simd
@testable import Lumen

final class AnalysisTests: XCTestCase {

    /// 20×20×10 grid, spacing 1×2×3 mm (6 mm³ per voxel).
    private func makeVolumes() -> (CTVolume, LabelVolume) {
        let dims = SIMD3<Int32>(20, 20, 10)
        let g = VolumeGeometry(dims: dims, spacing: [1, 2, 3], affine: matrix_identity_float4x4)
        var ct = [Int16](repeating: -1000, count: g.count)
        var lab = [UInt8](repeating: 0, count: g.count)
        // Liver: box x 2..5, y 2..5, z 2..5 (64 voxels), HU alternates 50/70 by x parity.
        for z in 2...5 { for y in 2...5 { for x in 2...5 {
            let i = g.index(x, y, z); lab[i] = Organ.liver.rawValue; ct[i] = x % 2 == 0 ? 50 : 70
        } } }
        // Pancreas head: box x 10..15, y 10..15, z 4..6.
        for z in 4...6 { for y in 10...15 { for x in 10...15 {
            let i = g.index(x, y, z); lab[i] = Organ.pancreasHead.rawValue; ct[i] = 40
        } } }
        // Pancreatic lesion inside the head: row of 5 voxels along x at y=12, z=5 (HU 20).
        for x in 11...15 { let i = g.index(x, 12, 5); lab[i] = Organ.pancreaticLesion.rawValue; ct[i] = 20 }
        // A second, separate lesion voxel (distinct component).
        let j = g.index(1, 18, 8); lab[j] = Organ.pancreaticLesion.rawValue; ct[j] = 30
        return (CTVolume(geometry: g, voxels: ct), LabelVolume(geometry: g, voxels: lab))
    }

    func testOrganStats() {
        let (ct, lab) = makeVolumes()
        let r = Analysis.compute(ct: ct, labels: lab)
        let liver = r.stat(.liver)!
        XCTAssertEqual(liver.voxelCount, 64)
        XCTAssertEqual(liver.volumeML, 64 * 6 / 1000, accuracy: 1e-9)
        XCTAssertEqual(liver.meanHU, 60, accuracy: 1e-9)
        XCTAssertEqual(liver.stdHU, 10, accuracy: 1e-9)          // population SD like np.std
        XCTAssertEqual(liver.minHU, 50); XCTAssertEqual(liver.maxHU, 70)
        XCTAssertEqual(liver.centroidVoxel, SIMD3<Float>(3.5, 3.5, 3.5))
        XCTAssertEqual(liver.extentMM, SIMD3<Float>(4, 8, 12))
        XCTAssertFalse(liver.truncated)
        XCTAssertEqual(r.stat(.pancreasHead)!.voxelCount, 6 * 6 * 3 - 5)
    }

    func testLesionsAndHost() {
        let (ct, lab) = makeVolumes()
        let r = Analysis.compute(ct: ct, labels: lab)
        XCTAssertEqual(r.lesions.count, 2)
        let big = r.lesions[0]
        XCTAssertEqual(big.voxelCount, 5)
        XCTAssertEqual(big.host, .pancreasHead)
        XCTAssertEqual(big.locationText, "pancreas head")
        XCTAssertEqual(big.longAxisMM, 5, accuracy: 0.05)   // 5 voxels × 1 mm along x
        XCTAssertEqual(big.shortAxisMM, 2, accuracy: 0.05)  // one voxel × 2 mm along y
        XCTAssertEqual(big.meanHU, 20, accuracy: 1e-9)
        XCTAssertEqual(big.centroidVoxel, SIMD3<Float>(13, 12, 5))
        XCTAssertEqual(r.lesions[1].voxelCount, 1)
        XCTAssertNil(r.lesions[1].host)
        XCTAssertTrue(Analysis.impression(r).first!.contains("2 pancreas lesions"))
    }

    func testPercentileOfMatchesOrganNormsTS() {
        let grid: [Double] = [0, 50, 100], q: [Double] = [10, 20, 40]
        XCTAssertEqual(Analysis.percentileOf(5, grid: grid, q: q), 0)
        XCTAssertEqual(Analysis.percentileOf(15, grid: grid, q: q), 25)
        XCTAssertEqual(Analysis.percentileOf(30, grid: grid, q: q), 75)
        XCTAssertEqual(Analysis.percentileOf(99, grid: grid, q: q), 100)
        XCTAssertEqual(Analysis.ageToBin("67"), "60-69")
        XCTAssertEqual(Analysis.ageToBin("95"), "90-99")
        XCTAssertEqual(Analysis.sizeDescriptor(volumeCC: nil, maxDimCM: 1.5), "small")
    }
}
