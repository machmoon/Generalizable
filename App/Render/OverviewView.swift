// OverviewView.swift  (E3, L3c)
//
// Mid-sagittal overview with the cut plane drawn as a line through the pivot. Folding the Duo
// changes `cut.tiltDegrees`, which rotates this line: the visual link between hinge and body.
//
// No Metal here on purpose: the sagittal image is rendered once on the CPU (per bundle / sagittal
// x index / visible layer set) into a small CGImage and cached; everything else is a Canvas.
//
// Prior art followed (read at source, 2026-09-26):
//   - cornerstone3D `packages/tools/src/tools/CrosshairsTool.ts`
//       * reference line drawn full-length with a centre gap: `centerGap = canvasMinDimensionLength
//         * referenceLinesCenterGapRatio` (mobile ratio 0.05, L227-231 / L1042-1045). We add a
//         10 pt floor (design spec [R]).
//       * line width 1 idle -> 2.5 while `activeOperation === DRAG` (L1304-1313), changed
//         instantly, not animated. We use 1.5 / 3 pt per the design spec.
//   - 3D Slicer `Libs/MRML/Core/vtkMRMLSegmentationDisplayNode.h` L384-386: fill + outline look
//     for label maps (fill 0.5 / outline 1.0); design spec deviates to 0.65 over a 0.35 grey base.
//   - Texel placement follows `CaseBundle.textureCoord(forMM:)` (voxel centres at
//     origin + ijk*spacing), so this overview agrees with the Metal SliceView to the half-voxel.
//
// Orientation: screen right = +y (anterior), screen up = +z (superior). Aspect is physical
// (mm), using meta.spacing_mm.

import SwiftUI
import simd

// Local copy of the shared tokens (E2 owns RenderStyle.swift; kept fileprivate here so this file
// typechecks on its own against App/Core and never collides with RenderStyle's names).
fileprivate enum OVStyle {
    static let canvasBG = Color.black
    static let outsideVolume = Color(red: 0x1C / 255, green: 0x1C / 255, blue: 0x1E / 255)
    static let volumeEdge = Color.white.opacity(0.12)
    static let cutAccent = Color(red: 0x64 / 255, green: 0xD2 / 255, blue: 0xFF / 255)
    static let findingInk = Color(red: 0xFF / 255, green: 0x2D / 255, blue: 0x95 / 255)
    static let halo = Color.black.opacity(0.55)
    static let plate = Color.black.opacity(0.55)
}

struct OverviewView: View {
    let bundle: CaseBundle
    @Binding var cut: CutPlane
    let visibleLayerIDs: Set<Int>

    init(bundle: CaseBundle, cut: Binding<CutPlane>, visibleLayerIDs: Set<Int>) {
        self.bundle = bundle
        self._cut = cut
        self.visibleLayerIDs = visibleLayerIDs
    }

    @State private var cache = SagittalImageCache()
    @State private var isDragging = false
    @State private var lastTranslation: CGSize = .zero

    var body: some View {
        GeometryReader { proxy in
            let size = proxy.size
            let xIndex = sagittalIndex
            let image = cache.image(bundle: bundle, xIndex: xIndex, visible: visibleLayerIDs)
            let geo = OverviewGeometry(bundle: bundle, cut: cut, xIndex: xIndex, size: size)

            ZStack(alignment: .topLeading) {
                Canvas { ctx, _ in
                    draw(into: &ctx, geo: geo, image: image)
                }
                .transaction { $0.animation = nil }   // width changes are instant (CrosshairsTool)

                // Hit area: one 44 pt band along the cut line plus a 44 pt disc on the handle.
                Color.clear
                    .contentShape(CutBandShape(geo: geo, bandWidth: 44, handleHit: 44))
                    .gesture(dragGesture(geo: geo))

                Text("Sagittal")
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(0.5)
                    .foregroundStyle(.white.opacity(0.85))
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(OVStyle.plate, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .padding(8)
                    .allowsHitTesting(false)
            }
            .sensoryFeedback(.impact(weight: .light), trigger: isDragging) { _, new in new }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Cut line")
            .accessibilityValue(accessibilityValueText)
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment: nudge(dy: 0, dz: 5)
                case .decrement: nudge(dy: 0, dz: -5)
                @unknown default: break
                }
            }
            .accessibilityAction(named: "Move forward") { nudge(dy: 5, dz: 0) }
            .accessibilityAction(named: "Move back") { nudge(dy: -5, dz: 0) }
        }
        .background(OVStyle.canvasBG)
        .clipped()
    }

    // MARK: Sagittal index (design spec: mid-sagittal slice through pivot.x)

    private var sagittalIndex: Int {
        let nx = bundle.meta.dims[0]
        let sx = Float(bundle.meta.spacingMM[0])
        let ox = Float(bundle.meta.originMM[0])
        let i = Int(((cut.pivotMM.x - ox) / sx).rounded())
        return min(max(i, 0), nx - 1)
    }

    // MARK: Drawing

    private func draw(into ctx: inout GraphicsContext, geo: OverviewGeometry, image: CGImage?) {
        let full = CGRect(origin: .zero, size: geo.size)
        ctx.fill(Path(full), with: .color(OVStyle.canvasBG))
        ctx.fill(Path(geo.imageRect), with: .color(OVStyle.outsideVolume))
        if let image {
            let img = Image(decorative: image, scale: 1).interpolation(.none)
            ctx.draw(img, in: geo.imageRect)
        }
        ctx.stroke(Path(geo.imageRect), with: .color(OVStyle.volumeEdge), lineWidth: 1)

        // Slice-offset connector: pivot -> cut origin, along the plane normal (dashed).
        if geo.hasOffset {
            var conn = Path()
            conn.move(to: geo.pivotPt)
            conn.addLine(to: geo.originPt)
            ctx.stroke(conn, with: .color(OVStyle.cutAccent.opacity(0.6)),
                       style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
        }

        // Cut line: full length with a centre gap around the pivot's foot on the line.
        if let dir = geo.lineDir {
            let reach = hypot(geo.size.width, geo.size.height) * 2
            let gap = max(10, 0.05 * min(geo.size.width, geo.size.height))
            let c = geo.gapCenter
            var line = Path()
            line.move(to: c - dir * reach); line.addLine(to: c - dir * gap)
            line.move(to: c + dir * gap);   line.addLine(to: c + dir * reach)
            let w: CGFloat = isDragging ? 3 : 1.5
            let haloW: CGFloat = isDragging ? 5 : 3.5
            ctx.stroke(line, with: .color(OVStyle.halo), style: StrokeStyle(lineWidth: haloW, lineCap: .round))
            ctx.stroke(line, with: .color(OVStyle.cutAccent), style: StrokeStyle(lineWidth: w, lineCap: .round))
        }

        // Slice-offset position (where the cut actually is, when offset != 0).
        if geo.hasOffset {
            let r: CGFloat = 3.5
            let dot = Path(ellipseIn: CGRect(x: geo.originPt.x - r, y: geo.originPt.y - r, width: 2 * r, height: 2 * r))
            ctx.fill(dot, with: .color(OVStyle.cutAccent))
            ctx.stroke(dot, with: .color(.black.opacity(0.6)), lineWidth: 1)
        }

        // Pivot marker: white "+" (7 pt arms) + magenta ring (min 10 pt diameter, or finding size).
        let p = geo.pivotPt
        let ringR = max(5, geo.pivotFindingRadiusPt)
        let ring = Path(ellipseIn: CGRect(x: p.x - ringR, y: p.y - ringR, width: 2 * ringR, height: 2 * ringR))
        ctx.stroke(ring, with: .color(OVStyle.halo), lineWidth: 3.5)
        ctx.stroke(ring, with: .color(OVStyle.findingInk), lineWidth: 1.5)
        var plus = Path()
        plus.move(to: CGPoint(x: p.x - 7, y: p.y)); plus.addLine(to: CGPoint(x: p.x + 7, y: p.y))
        plus.move(to: CGPoint(x: p.x, y: p.y - 7)); plus.addLine(to: CGPoint(x: p.x, y: p.y + 7))
        ctx.stroke(plus, with: .color(OVStyle.halo), lineWidth: 3)
        ctx.stroke(plus, with: .color(.white), lineWidth: 1)

        // Drag handle: 22 pt disc (28 while dragging), cutAccent fill, 2 pt white stroke.
        if let h = geo.handlePt {
            let d: CGFloat = isDragging ? 28 : 22
            let disc = Path(ellipseIn: CGRect(x: h.x - d / 2, y: h.y - d / 2, width: d, height: d))
            ctx.fill(disc, with: .color(OVStyle.cutAccent))
            ctx.stroke(disc, with: .color(.white), lineWidth: 2)
        }
    }

    // MARK: Interaction

    private func dragGesture(geo: OverviewGeometry) -> some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { value in
                if !isDragging {
                    isDragging = true
                    lastTranslation = .zero
                }
                let dx = value.translation.width - lastTranslation.width
                let dy = value.translation.height - lastTranslation.height
                lastTranslation = value.translation
                guard geo.ptPerMM > 0 else { return }
                // screen right = +y (anterior), screen up = +z (superior)
                nudge(dy: Float(dx / geo.ptPerMM), dz: Float(-dy / geo.ptPerMM))
            }
            .onEnded { _ in
                isDragging = false
                lastTranslation = .zero
            }
    }

    /// Moves the pivot within the sagittal (y-z) plane via cut.dragPivot, clamped to the volume.
    private func nudge(dy: Float, dz: Float) {
        let lo = bundle.mm(forVoxel: SIMD3<Int>(0, 0, 0))
        let hi = bundle.mm(forVoxel: SIMD3<Int>(bundle.meta.dims[0] - 1, bundle.meta.dims[1] - 1, bundle.meta.dims[2] - 1))
        let p = cut.pivotMM
        let ny = min(max(p.y + dy, lo.y), hi.y)
        let nz = min(max(p.z + dz, lo.z), hi.z)
        let d = SIMD3<Float>(0, ny - p.y, nz - p.z)
        if d != .zero { cut.dragPivot(byMM: d) }
    }

    private var accessibilityValueText: String {
        let t = Int(cut.tiltDegrees.rounded())
        let c = bundle.centerMM
        let fy = Int((cut.pivotMM.y - c.y).rounded())
        let fz = Int((cut.pivotMM.z - c.z).rounded())
        return "Tilt \(t) degrees. Pivot \(fy) millimetres forward, \(fz) millimetres up from centre."
    }
}

// MARK: - Geometry (shared by Canvas drawing and the hit shape)

fileprivate struct OverviewGeometry {
    let size: CGSize
    let imageRect: CGRect
    let ptPerMM: CGFloat
    let pivotPt: CGPoint
    let originPt: CGPoint          // cut origin (pivot + normal*offset) projected into this plane
    let hasOffset: Bool
    let lineDir: CGPoint?          // unit screen direction of the cut line; nil if plane is parallel
    let linePoint: CGPoint         // a point on the cut line
    let gapCenter: CGPoint         // pivot's foot on the cut line
    let handlePt: CGPoint?
    let pivotFindingRadiusPt: CGFloat

    init(bundle: CaseBundle, cut: CutPlane, xIndex: Int, size: CGSize) {
        self.size = size
        let dims = bundle.meta.dims
        let sp = bundle.meta.spacingMM
        let og = bundle.meta.originMM
        // Texel-centre convention (CaseBundle.textureCoord): texture spans origin - s/2 ... origin + (n - 1/2)s.
        let yMin = og[1] - sp[1] / 2, zMin = og[2] - sp[2] / 2
        let extY = Double(dims[1]) * sp[1], extZ = Double(dims[2]) * sp[2]
        let s = (extY > 0 && extZ > 0) ? min(Double(size.width) / extY, Double(size.height) / extZ) : 0
        ptPerMM = CGFloat(s)
        let w = CGFloat(extY * s), h = CGFloat(extZ * s)
        let rect = CGRect(x: (size.width - w) / 2, y: (size.height - h) / 2, width: w, height: h)
        imageRect = rect

        func toPt(_ y: Float, _ z: Float) -> CGPoint {
            CGPoint(x: rect.minX + CGFloat((Double(y) - yMin) * s),
                    y: rect.maxY - CGFloat((Double(z) - zMin) * s))
        }

        let x0 = bundle.mm(forVoxel: SIMD3<Int>(xIndex, 0, 0)).x
        let n = cut.normal
        let o = cut.originMM
        pivotPt = toPt(cut.pivotMM.y, cut.pivotMM.z)

        // Plane: n . (p - o) = 0, intersected with x = x0. Take the point with p.yz nearest o.yz.
        let nyz = SIMD2<Float>(n.y, n.z)
        let nyz2 = simd_length_squared(nyz)
        var q = SIMD2<Float>(o.y, o.z)
        if nyz2 > 1e-6 {
            q -= nyz * (n.x * (x0 - o.x) / nyz2)
        }
        let onLine = toPt(q.x, q.y)
        linePoint = onLine
        originPt = toPt(o.y, o.z)
        hasOffset = abs(cut.sliceOffsetMM) > 0.01

        // Line direction in (y,z) = n x e_x = (0, n.z, -n.y). At rotation 0 this equals vAxis.yz.
        // Screen: (+y -> +x, +z -> -y).
        var dir: CGPoint? = nil
        if nyz2 > 1e-6 {
            var d = CGPoint(x: CGFloat(n.z), y: CGFloat(n.y))   // (dy, -dz) with dy = n.z, dz = -n.y
            let len = hypot(d.x, d.y)
            d = CGPoint(x: d.x / len, y: d.y / len)
            // Canonical orientation: point rightward (or up when vertical) so the handle side is stable.
            if d.x < -1e-4 || (abs(d.x) <= 1e-4 && d.y > 0) { d = CGPoint(x: -d.x, y: -d.y) }
            dir = d
        }
        lineDir = dir

        if let d = dir {
            let t = (pivotPt.x - onLine.x) * d.x + (pivotPt.y - onLine.y) * d.y
            let foot = CGPoint(x: onLine.x + d.x * t, y: onLine.y + d.y * t)
            gapCenter = foot
            // Handle 40 pt from the pivot's foot along the line; flip side if it would leave the
            // view, then clamp 16 pt inside.
            let inset = CGRect(origin: .zero, size: size).insetBy(dx: 16, dy: 16)
            var hp = CGPoint(x: foot.x + d.x * 40, y: foot.y + d.y * 40)
            if !inset.contains(hp) {
                let alt = CGPoint(x: foot.x - d.x * 40, y: foot.y - d.y * 40)
                if inset.contains(alt) { hp = alt }
            }
            if inset.width > 0 && inset.height > 0 {
                hp.x = min(max(hp.x, inset.minX), inset.maxX)
                hp.y = min(max(hp.y, inset.minY), inset.maxY)
            }
            handlePt = hp
        } else {
            gapCenter = pivotPt
            handlePt = nil
        }

        // If the pivot sits on a finding, size the ring to its radius (as it appears at x0).
        var rPt: CGFloat = 0
        for f in bundle.findings where simd_distance(f.center, cut.pivotMM) < 0.5 {
            let dx = Double(f.center.x - x0)
            let r2 = f.radiusMM * f.radiusMM - dx * dx
            rPt = r2 > 0 ? CGFloat(r2.squareRoot() * s) : 0
            break
        }
        pivotFindingRadiusPt = rPt
    }
}

fileprivate func - (a: CGPoint, b: CGPoint) -> CGPoint { CGPoint(x: a.x - b.x, y: a.y - b.y) }
fileprivate func + (a: CGPoint, b: CGPoint) -> CGPoint { CGPoint(x: a.x + b.x, y: a.y + b.y) }
fileprivate func * (a: CGPoint, k: CGFloat) -> CGPoint { CGPoint(x: a.x * k, y: a.y * k) }

/// Hit region: a band along the cut line plus a disc on the handle (and the pivot).
fileprivate struct CutBandShape: Shape {
    let geo: OverviewGeometry
    let bandWidth: CGFloat
    let handleHit: CGFloat

    func path(in rect: CGRect) -> Path {
        var p = Path()
        if let d = geo.lineDir {
            let reach = hypot(rect.width, rect.height) * 2
            let n = CGPoint(x: -d.y, y: d.x) * (bandWidth / 2)
            let c = geo.gapCenter
            let a = c - d * reach, b = c + d * reach
            p.move(to: a + n); p.addLine(to: b + n); p.addLine(to: b - n); p.addLine(to: a - n)
            p.closeSubpath()
        }
        for pt in [geo.handlePt, geo.pivotPt].compactMap({ $0 }) {
            p.addEllipse(in: CGRect(x: pt.x - handleHit / 2, y: pt.y - handleHit / 2,
                                    width: handleHit, height: handleHit))
        }
        return p
    }
}

// MARK: - CPU sagittal renderer + cache

/// Not observed on purpose: it is a memo, mutated from `body`, keyed by everything the pixels depend on.
fileprivate final class SagittalImageCache {
    private struct Key: Equatable {
        let bundle: ObjectIdentifier
        let xIndex: Int
        let visible: Set<Int>
    }
    private var key: Key?
    private var cached: CGImage?

    func image(bundle: CaseBundle, xIndex: Int, visible: Set<Int>) -> CGImage? {
        let k = Key(bundle: ObjectIdentifier(bundle), xIndex: xIndex, visible: visible)
        if k == key { return cached }
        cached = Self.render(bundle: bundle, xIndex: xIndex, visible: visible)
        key = k
        return cached
    }

    /// Layers-mode pixels (design spec section 2), matching the SliceView shader recipe:
    /// base = windowed grey (soft preset) * 0.35; dark label colours lifted 30% toward white;
    /// out = mix(base, c, 0.65); 1 px outline at lighten(c, 0.15) on 4-neighbour label changes.
    static func render(bundle: CaseBundle, xIndex: Int, visible: Set<Int>) -> CGImage? {
        let dims = bundle.meta.dims
        guard dims.count == 3 else { return nil }
        let ny = dims[1], nz = dims[2]
        guard ny > 0, nz > 0, xIndex >= 0, xIndex < dims[0] else { return nil }

        let win = bundle.meta.windowPresets["soft"]
            ?? bundle.meta.windowPresets.sorted(by: { $0.key < $1.key }).first?.value
            ?? [40, 400]
        let level = Float(win.first ?? 40)
        let width = max(Float(win.count > 1 ? win[1] : 400), 1)
        let lo = level - width / 2

        var colors = [SIMD3<Float>?](repeating: nil, count: 256)
        for layer in bundle.layers where visible.contains(layer.id) && (1...255).contains(layer.id) {
            var c = SIMD3<Float>(layer.rgba.x, layer.rgba.y, layer.rgba.z)
            let luma = simd_dot(c, SIMD3<Float>(0.2126, 0.7152, 0.0722))
            if luma < 0.18 { c = simd_mix(c, SIMD3<Float>(repeating: 1), SIMD3<Float>(repeating: 0.30)) }
            colors[layer.id] = c
        }

        // Row 0 of the image is the top = highest z.
        var labelGrid = [UInt8](repeating: 0, count: ny * nz)
        var rgba = [UInt8](repeating: 255, count: ny * nz * 4)
        for row in 0..<nz {
            let k = nz - 1 - row
            for j in 0..<ny {
                let ijk = SIMD3<Int>(xIndex, j, k)
                let lab = bundle.label(at: ijk)
                labelGrid[row * ny + j] = colors[Int(lab)] == nil ? 0 : lab
                let hu = Float(bundle.hu(at: ijk))
                let g = min(max((hu - lo) / width, 0), 1) * 0.35
                var out = SIMD3<Float>(repeating: g)
                if let c = colors[Int(lab)] {
                    out = simd_mix(out, c, SIMD3<Float>(repeating: 0.65))
                }
                let o = (row * ny + j) * 4
                rgba[o] = UInt8(out.x * 255); rgba[o + 1] = UInt8(out.y * 255); rgba[o + 2] = UInt8(out.z * 255)
            }
        }
        // Outline pass.
        for row in 0..<nz {
            for j in 0..<ny {
                let lab = labelGrid[row * ny + j]
                guard lab != 0, let c = colors[Int(lab)] else { continue }
                let edge = (j > 0 && labelGrid[row * ny + j - 1] != lab)
                    || (j < ny - 1 && labelGrid[row * ny + j + 1] != lab)
                    || (row > 0 && labelGrid[(row - 1) * ny + j] != lab)
                    || (row < nz - 1 && labelGrid[(row + 1) * ny + j] != lab)
                guard edge else { continue }
                let e = simd_mix(c, SIMD3<Float>(repeating: 1), SIMD3<Float>(repeating: 0.15))
                let o = (row * ny + j) * 4
                rgba[o] = UInt8(e.x * 255); rgba[o + 1] = UInt8(e.y * 255); rgba[o + 2] = UInt8(e.z * 255)
            }
        }

        guard let provider = CGDataProvider(data: Data(rgba) as CFData) else { return nil }
        return CGImage(width: ny, height: nz, bitsPerComponent: 8, bitsPerPixel: 32,
                       bytesPerRow: ny * 4, space: CGColorSpaceCreateDeviceRGB(),
                       bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                       provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    }
}
