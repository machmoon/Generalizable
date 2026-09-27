// Shared contracts for every module in Lumen. Owned by the integrator (not by any one
// agent). Change only with a stated reason; everything else compiles against this.
//
// Conventions
// - Volumes are stored in RAS+ closest-canonical voxel order, the same normalisation
//   nibabel applies in `as_closest_canonical` (nibabel/funcs.py): +x → patient Right,
//   +y → Anterior, +z → Superior.
// - Linear index = x + y*dims.x + z*dims.x*dims.y (NIfTI/Fortran order).
// - HU values are stored as Int16 after applying scl_slope/scl_inter.
// - Label values are UInt8; value k (1...35) is `Organ(rawValue: k)`; 0 is background.

import Foundation
import simd
import SwiftUI

// MARK: - Anatomy

/// Canonical storage: +x → patient Right, +y → Anterior, +z → Superior (nibabel RAS+).
/// Display is radiological (patient's right on the screen's left) — see `Plane`.
enum Anatomy {}

// MARK: - Volumes

struct VolumeGeometry: Sendable, Equatable {
    /// Voxel counts along canonical x, y, z.
    var dims: SIMD3<Int32>
    /// Voxel size in millimetres along canonical x, y, z.
    var spacing: SIMD3<Float>
    /// Canonical voxel index → world (RAS, mm) affine.
    var affine: simd_float4x4

    var count: Int { Int(dims.x) * Int(dims.y) * Int(dims.z) }
    var extentMM: SIMD3<Float> { SIMD3<Float>(dims) * spacing }

    @inline(__always) func index(_ x: Int, _ y: Int, _ z: Int) -> Int {
        x + y * Int(dims.x) + z * Int(dims.x) * Int(dims.y)
    }
    func contains(_ v: SIMD3<Float>) -> Bool {
        all(v .>= .zero) && all(v .< SIMD3<Float>(dims))
    }
    func clamp(_ v: SIMD3<Float>) -> SIMD3<Float> {
        simd_clamp(v, .zero, SIMD3<Float>(dims) - 1)
    }
}

/// CT intensities in Hounsfield units, canonical order.
final class CTVolume: @unchecked Sendable {
    let geometry: VolumeGeometry
    let voxels: [Int16]
    init(geometry: VolumeGeometry, voxels: [Int16]) {
        precondition(voxels.count == geometry.count)
        self.geometry = geometry
        self.voxels = voxels
    }
    func hu(at v: SIMD3<Float>) -> Int16? {
        guard geometry.contains(v) else { return nil }
        return voxels[geometry.index(Int(v.x), Int(v.y), Int(v.z))]
    }
}

/// Organ labels, same grid as the CT, canonical order.
final class LabelVolume: @unchecked Sendable {
    let geometry: VolumeGeometry
    let voxels: [UInt8]
    init(geometry: VolumeGeometry, voxels: [UInt8]) {
        precondition(voxels.count == geometry.count)
        self.geometry = geometry
        self.voxels = voxels
    }
    func organ(at v: SIMD3<Float>) -> Organ? {
        guard geometry.contains(v) else { return nil }
        return Organ(rawValue: voxels[geometry.index(Int(v.x), Int(v.y), Int(v.z))])
    }
}

// MARK: - Cases

struct CaseInfo: Identifiable, Hashable, Sendable, Codable {
    /// e.g. "PanTS_00008205"
    var id: String
    var title: String
    /// Local file URLs once available (bundled or downloaded). nil = not on device yet.
    var ctURL: URL?
    var labelURL: URL?
    var thumbnailURL: URL?
    var metadata: [String: String] = [:]   // age, sex, scanner, etc. when known
    var isBundled: Bool = false
}

struct LoadedCase: Sendable {
    let info: CaseInfo
    let ct: CTVolume
    let labels: LabelVolume?
}

// MARK: - Organs (label ids and colours ported from BodyMaps
// PanTS-Demo/src/helpers/constants.ts: `segmentation_categories`, `segmentation_category_colors`)

enum Organ: UInt8, CaseIterable, Identifiable, Sendable, Codable {
    case adrenalGlandLeft = 1, adrenalGlandRight, aorta, bladder, celiacArtery, colon,
         commonBileDuct, duodenum, femurLeft, femurRight, gallBladder, kidneyLeft,
         kidneyRight, liver, lungLeft, lungRight, pancreas, pancreasBody, pancreasHead,
         pancreasTail, pancreaticDuct, pancreaticLesion, postcava, prostate, spleen,
         stomach, superiorMesentericArtery, veins, intestine, renalVeinLeft,
         renalVeinRight, cbdStent, liverLesion, kidneyLesion, colonLesion

    var id: UInt8 { rawValue }

    /// BodyMaps key, e.g. "adrenal_gland_left".
    var key: String { Organ.keys[Int(rawValue) - 1] }
    var displayName: String {
        key.replacingOccurrences(of: "_", with: " ").capitalized
            .replacingOccurrences(of: "Cbd", with: "CBD")
    }
    var isLesion: Bool { [.pancreaticLesion, .liverLesion, .kidneyLesion, .colonLesion].contains(self) }

    /// RGBA 0...255 exactly as BodyMaps ships them.
    var rgba: SIMD4<UInt8> { Organ.colors[Int(rawValue) - 1] }
    var color: Color {
        Color(red: Double(rgba.x) / 255, green: Double(rgba.y) / 255, blue: Double(rgba.z) / 255)
    }

    static let keys = [
        "adrenal_gland_left", "adrenal_gland_right", "aorta", "bladder", "celiac_artery",
        "colon", "common_bile_duct", "duodenum", "femur_left", "femur_right", "gall_bladder",
        "kidney_left", "kidney_right", "liver", "lung_left", "lung_right", "pancreas",
        "pancreas_body", "pancreas_head", "pancreas_tail", "pancreatic_duct",
        "pancreatic_lesion", "postcava", "prostate", "spleen", "stomach",
        "superior_mesenteric_artery", "veins", "intestine", "renal_vein_left",
        "renal_vein_right", "cbd_stent", "liver_lesion", "kidney_lesion", "colon_lesion",
    ]
    static let colors: [SIMD4<UInt8>] = [
        [255, 140, 0, 254], [255, 165, 0, 254], [255, 0, 0, 254], [0, 191, 255, 254],
        [220, 20, 60, 254], [255, 160, 255, 254], [34, 139, 34, 254], [255, 127, 80, 254],
        [245, 245, 245, 254], [220, 220, 220, 254], [0, 128, 0, 254], [68, 229, 133, 254],
        [68, 229, 181, 254], [178, 34, 34, 254], [68, 181, 229, 254], [68, 133, 229, 254],
        [255, 182, 193, 254], [255, 105, 180, 254], [219, 112, 147, 254], [255, 160, 122, 254],
        [255, 228, 181, 254], [80, 0, 0, 254], [72, 61, 139, 254], [255, 105, 180, 254],
        [138, 43, 226, 254], [255, 99, 71, 254], [255, 69, 0, 254], [106, 90, 205, 254],
        [255, 200, 120, 254], [100, 149, 237, 254], [70, 130, 180, 254], [192, 192, 192, 254],
        [255, 140, 0, 254], [255, 215, 0, 254], [220, 20, 60, 254],
    ]
}

// MARK: - Display

enum Plane: String, CaseIterable, Identifiable, Sendable {
    case axial, coronal, sagittal
    var id: String { rawValue }
    /// Canonical voxel axis normal to this plane.
    var normalAxis: Int { switch self { case .axial: 2; case .coronal: 1; case .sagittal: 0 } }
    /// Canonical axes shown along screen-x and screen-y.
    var uAxis: Int { switch self { case .axial, .coronal: 0; case .sagittal: 1 } }
    var vAxis: Int { switch self { case .axial: 1; case .coronal, .sagittal: 2 } }
    /// Radiological display: patient right on screen left, anterior at top (axial),
    /// superior at top (coronal/sagittal), anterior on screen left (sagittal).
    /// With RAS+ storage, screen-x increases as u *decreases* when flipU is true, and
    /// screen-y (downwards) increases as v *decreases* when flipV is true.
    var flipU: Bool { true }
    var flipV: Bool { true }
}

struct WindowLevel: Hashable, Sendable, Identifiable {
    var name: String
    var center: Float
    var width: Float
    var id: String { name }
    var low: Float { center - width / 2 }
    var high: Float { center + width / 2 }

    // Standard CT presets (same values OsiriX/Horos and 3D Slicer ship).
    static let softTissue = WindowLevel(name: "Soft Tissue", center: 40, width: 400)
    static let abdomen = WindowLevel(name: "Abdomen", center: 60, width: 350)
    static let liver = WindowLevel(name: "Liver", center: 80, width: 150)
    static let lung = WindowLevel(name: "Lung", center: -600, width: 1500)
    static let bone = WindowLevel(name: "Bone", center: 400, width: 1800)
    static let presets: [WindowLevel] = [.softTissue, .abdomen, .liver, .lung, .bone]
}

/// Maps between a plane's voxel coordinates and a view's points. The slice renderer
/// draws a textured quad whose corners are `voxelToView` of the slice's corners, and
/// every overlay/gesture uses the same functions, so they always line up.
struct SliceViewport: Equatable, Sendable {
    var plane: Plane
    var viewSize: CGSize
    /// 1 = the slice's physical extent fits the view (aspect preserved).
    var zoom: CGFloat = 1
    /// Offset of the image centre from the view centre, in points.
    var pan: CGSize = .zero

    /// Points per millimetre at the current zoom.
    func pointsPerMM(_ g: VolumeGeometry) -> CGFloat {
        let ext = g.extentMM
        let wMM = CGFloat(ext[plane.uAxis]), hMM = CGFloat(ext[plane.vAxis])
        guard wMM > 0, hMM > 0, viewSize.width > 0, viewSize.height > 0 else { return 1 }
        return min(viewSize.width / wMM, viewSize.height / hMM) * zoom
    }

    func voxelToView(_ v: SIMD3<Float>, _ g: VolumeGeometry) -> CGPoint {
        let s = pointsPerMM(g)
        let u = CGFloat(v[plane.uAxis] + 0.5) * CGFloat(g.spacing[plane.uAxis])
        let w = CGFloat(v[plane.vAxis] + 0.5) * CGFloat(g.spacing[plane.vAxis])
        let uMax = CGFloat(g.extentMM[plane.uAxis]), vMax = CGFloat(g.extentMM[plane.vAxis])
        let du = (plane.flipU ? uMax - u : u) - uMax / 2
        let dv = (plane.flipV ? vMax - w : w) - vMax / 2
        return CGPoint(x: viewSize.width / 2 + pan.width + du * s,
                       y: viewSize.height / 2 + pan.height + dv * s)
    }

    /// `slice` is the voxel coordinate along the plane normal.
    func viewToVoxel(_ p: CGPoint, slice: Float, _ g: VolumeGeometry) -> SIMD3<Float> {
        let s = pointsPerMM(g)
        let uMax = CGFloat(g.extentMM[plane.uAxis]), vMax = CGFloat(g.extentMM[plane.vAxis])
        let du = (p.x - viewSize.width / 2 - pan.width) / s + uMax / 2
        let dv = (p.y - viewSize.height / 2 - pan.height) / s + vMax / 2
        let u = plane.flipU ? uMax - du : du
        let w = plane.flipV ? vMax - dv : dv
        var out = SIMD3<Float>(repeating: slice)
        out[plane.uAxis] = Float(u) / g.spacing[plane.uAxis] - 0.5
        out[plane.vAxis] = Float(w) / g.spacing[plane.vAxis] - 0.5
        return out
    }
}

struct Measurement: Identifiable, Hashable, Sendable {
    var id = UUID()
    var plane: Plane
    var start: SIMD3<Float>   // voxel coords
    var end: SIMD3<Float>
    func lengthMM(_ g: VolumeGeometry) -> Float { simd_length((end - start) * g.spacing) }
}

enum ViewerLayout: String, CaseIterable, Identifiable, Sendable {
    case quad, single, volumeFocus
    var id: String { rawValue }
}

enum VolumeRenderMode: String, CaseIterable, Identifiable, Sendable {
    case meshes, volume, mip
    var id: String { rawValue }
}

// MARK: - Viewer state (single source of truth for one open case)

@MainActor @Observable
final class ViewerState {
    let loaded: LoadedCase
    var geometry: VolumeGeometry { loaded.ct.geometry }

    /// Crosshair position in canonical voxel coordinates (shared by all planes).
    var cursor: SIMD3<Float>
    var window: WindowLevel = .softTissue
    var visibleOrgans: Set<Organ>
    var labelOpacity: Float = 0.45
    var showLabels = true
    var selectedOrgan: Organ?
    var layout: ViewerLayout = .quad
    var focusedPlane: Plane = .axial
    var volumeMode: VolumeRenderMode = .meshes
    /// Per-plane zoom/pan; viewSize is filled in by each SliceView.
    var viewports: [Plane: SliceViewport] = Dictionary(
        uniqueKeysWithValues: Plane.allCases.map { ($0, SliceViewport(plane: $0, viewSize: .zero)) })
    var measurements: [Measurement] = []
    var activeTool: Tool = .navigate
    /// Oblique cut for the 3D view / Duo hinge: unit normal in canonical voxel space
    /// through `cursor`. nil = no clipping.
    var clipNormal: SIMD3<Float>?

    enum Tool: String, CaseIterable, Identifiable, Sendable {
        case navigate, windowLevel, measure, probe
        var id: String { rawValue }
    }

    init(loaded: LoadedCase) {
        self.loaded = loaded
        let d = SIMD3<Float>(loaded.ct.geometry.dims)
        cursor = (d / 2).rounded(.down)
        var seen = [Bool](repeating: false, count: 256)
        loaded.labels?.voxels.withUnsafeBufferPointer { buf in for v in buf { seen[Int(v)] = true } }
        visibleOrgans = Set(Organ.allCases.filter { seen[Int($0.rawValue)] })
    }

    func slice(for plane: Plane) -> Float { cursor[plane.normalAxis] }
    func setSlice(_ value: Float, for plane: Plane) {
        let maxV = Float(geometry.dims[plane.normalAxis] - 1)
        cursor[plane.normalAxis] = min(max(value.rounded(), 0), maxV)
    }
    func sliceCount(for plane: Plane) -> Int { Int(geometry.dims[plane.normalAxis]) }
}
