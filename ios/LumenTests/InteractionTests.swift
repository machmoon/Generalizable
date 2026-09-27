import XCTest
@testable import Lumen

final class InteractionTests: XCTestCase {
    func testWindowLevelDragMapping() {
        let wl = WindowLevel(name: "x", center: 40, width: 400)
        let out = InteractionMath.windowLevel(wl, dx: 10, dy: -5, multiplier: 4)
        XCTAssertEqual(out.width, 440)
        XCTAssertEqual(out.center, 20)
        XCTAssertEqual(out.name, "Custom")
        XCTAssertEqual(InteractionMath.windowLevel(wl, dx: -1000, dy: 0, multiplier: 4).width, 1)
    }

    func testMultiplierFromDynamicRange() {
        XCTAssertEqual(InteractionMath.wlMultiplier(dynamicRange: 4096), 4)
        XCTAssertEqual(InteractionMath.wlMultiplier(dynamicRange: 3000), 3)
        XCTAssertEqual(InteractionMath.wlMultiplier(dynamicRange: 512), 0.5)
        XCTAssertEqual(InteractionMath.wlMultiplier(dynamicRange: .nan), 4)
    }

    func testStackScrollAccumulator() {
        XCTAssertEqual(InteractionMath.pixelsPerImage(viewHeight: 400, sliceCount: 200), 2)
        XCTAssertEqual(InteractionMath.pixelsPerImage(viewHeight: 400, sliceCount: 4), 50)
        var r = InteractionMath.stackScroll(accumulated: 0, delta: 3, pixelsPerImage: 4)
        XCTAssertEqual(r.steps, 0); XCTAssertEqual(r.remainder, 3)
        r = InteractionMath.stackScroll(accumulated: r.remainder, delta: 6, pixelsPerImage: 4)
        XCTAssertEqual(r.steps, 2); XCTAssertEqual(r.remainder, 1)
        r = InteractionMath.stackScroll(accumulated: 0, delta: -9, pixelsPerImage: 4)
        XCTAssertEqual(r.steps, -2); XCTAssertEqual(r.remainder, -1)
    }

    func testZoomKeepsFocusFixed() {
        let size = CGSize(width: 400, height: 300)
        let focus = CGPoint(x: 300, y: 50)
        let pan = CGSize(width: 12, height: -7)
        let newPan = InteractionMath.zoomPan(pan: pan, zoom: 1.5, newZoom: 3, focus: focus, viewSize: size)
        // Image point k under focus before == after.
        let k0 = (focus.x - 200 - pan.width) / 1.5, k1 = (focus.x - 200 - newPan.width) / 3
        XCTAssertEqual(k0, k1, accuracy: 1e-9)
        let j0 = (focus.y - 150 - pan.height) / 1.5, j1 = (focus.y - 150 - newPan.height) / 3
        XCTAssertEqual(j0, j1, accuracy: 1e-9)
    }

    func testMeasurementVisibilityAndSegmentDistance() {
        let m = Measurement(plane: .axial, start: [1, 2, 10], end: [5, 2, 10])
        XCTAssertTrue(InteractionMath.isVisible(m, plane: .axial, slice: 10.5))
        XCTAssertFalse(InteractionMath.isVisible(m, plane: .axial, slice: 11))
        XCTAssertFalse(InteractionMath.isVisible(m, plane: .coronal, slice: 10))
        XCTAssertEqual(InteractionMath.distanceToSegment(CGPoint(x: 5, y: 3), .zero, CGPoint(x: 10, y: 0)), 3, accuracy: 1e-9)
    }
}
