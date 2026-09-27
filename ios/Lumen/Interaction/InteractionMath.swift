// Pure interaction math for SliceInteractionLayer. Ported from Cornerstone3D
// (github.com/cornerstonejs/cornerstone3D, main):
// - packages/tools/src/tools/WindowLevelTool.ts — getNewRange(): ww += dx*m, wc += dy*m,
//   ww = max(ww, 1); multiplier m from _getMultiplierFromDynamicRange():
//   ratio = dynamicRange / 1024, m = ratio > 1 ? round(ratio) : ratio (default 4).
// - packages/tools/src/tools/StackScrollTool.ts — mouseDragCallback / _getPixelPerImage():
//   pixelsPerImage = max(2, height / max(nSlices, 8)); accumulate deltaY, step
//   round(deltaY / pixelsPerImage) slices, keep the remainder (deltaY % pixelsPerImage).
// - packages/tools/src/tools/annotation/LengthTool.ts — isPointNearTool / handle proximity
//   (grab an endpoint handle if within `proximity` points, else create a new annotation).
import CoreGraphics
import Foundation
import simd

enum InteractionMath {
    static let defaultWLMultiplier: Float = 4
    static let defaultImageDynamicRange: Float = 1024

    /// Cornerstone WindowLevelTool._getMultiplierFromDynamicRange.
    static func wlMultiplier(dynamicRange: Float) -> Float {
        guard dynamicRange.isFinite, dynamicRange > 0 else { return defaultWLMultiplier }
        let ratio = dynamicRange / defaultImageDynamicRange
        return ratio > 1 ? ratio.rounded() : ratio
    }

    /// Cornerstone WindowLevelTool.getNewRange: horizontal → width, vertical → center.
    static func windowLevel(_ wl: WindowLevel, dx: CGFloat, dy: CGFloat, multiplier: Float) -> WindowLevel {
        var width = wl.width + Float(dx) * multiplier
        let center = wl.center + Float(dy) * multiplier
        width = max(width, 1)
        return WindowLevel(name: "Custom", center: center, width: width)
    }

    /// Cornerstone StackScrollTool._getPixelPerImage.
    static func pixelsPerImage(viewHeight: CGFloat, sliceCount: Int) -> CGFloat {
        max(2, viewHeight / CGFloat(max(sliceCount, 8)))
    }

    /// Cornerstone StackScrollTool.mouseDragCallback: returns (slice steps, leftover px).
    static func stackScroll(accumulated: CGFloat, delta: CGFloat, pixelsPerImage: CGFloat) -> (steps: Int, remainder: CGFloat) {
        let d = accumulated + delta
        guard pixelsPerImage > 0, abs(d) >= pixelsPerImage else { return (0, d) }
        let steps = Int((d / pixelsPerImage).rounded())
        return (steps, d.truncatingRemainder(dividingBy: pixelsPerImage))
    }

    /// Zoom about a focal point so the image point under `focus` stays put.
    /// view = centre + pan + k*zoom  ⇒  k = (focus - centre - pan)/zoom, pan' = focus - centre - k*zoom'.
    static func zoomPan(pan: CGSize, zoom: CGFloat, newZoom: CGFloat, focus: CGPoint, viewSize: CGSize) -> CGSize {
        guard zoom > 0 else { return pan }
        let cx = viewSize.width / 2, cy = viewSize.height / 2
        let kx = (focus.x - cx - pan.width) / zoom
        let ky = (focus.y - cy - pan.height) / zoom
        return CGSize(width: focus.x - cx - kx * newZoom, height: focus.y - cy - ky * newZoom)
    }

    static let minZoom: CGFloat = 0.5
    static let maxZoom: CGFloat = 12

    /// A measurement belongs to the slice it was drawn on (±0.5 voxel).
    static func isVisible(_ m: Measurement, plane: Plane, slice: Float) -> Bool {
        m.plane == plane && abs(m.start[plane.normalAxis] - slice) <= 0.5
    }

    static func distance(_ a: CGPoint, _ b: CGPoint) -> CGFloat { hypot(a.x - b.x, a.y - b.y) }

    /// Distance from p to segment ab (LengthTool.isPointNearTool uses the same test).
    static func distanceToSegment(_ p: CGPoint, _ a: CGPoint, _ b: CGPoint) -> CGFloat {
        let abx = b.x - a.x, aby = b.y - a.y
        let len2 = abx * abx + aby * aby
        guard len2 > 0 else { return distance(p, a) }
        let t = max(0, min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2))
        return distance(p, CGPoint(x: a.x + t * abx, y: a.y + t * aby))
    }
}
