import XCTest
import simd
@testable import Lumen

final class SmokeTests: XCTestCase {
    func testViewportRoundTrip() {
        let g = VolumeGeometry(dims: [100, 80, 60], spacing: [0.8, 0.8, 2], affine: matrix_identity_float4x4)
        for plane in Plane.allCases {
            let vp = SliceViewport(plane: plane, viewSize: CGSize(width: 300, height: 400), zoom: 1.3, pan: CGSize(width: 12, height: -7))
            let v = SIMD3<Float>(31, 22, 17)
            let back = vp.viewToVoxel(vp.voxelToView(v, g), slice: v[plane.normalAxis], g)
            XCTAssertLessThan(simd_length(back - v), 1e-3)
        }
    }
}
