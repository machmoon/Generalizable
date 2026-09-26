import SwiftUI

/// Physical pose of an iPhone Duo hinge, flattened so callers never touch
/// iOS 27.1-only types. `.noHinge` covers pre-27.1 OSes and hierarchies with no hinge.
///
/// Source: SwiftUICore.swiftinterface (iPhoneSimulator27.1.sdk)
///   `@available(anyAppleOS 27.1, *) public struct DeviceHinge { var status: Status; var angle: Angle }`
///   `DeviceHinge.Status { static closed, partiallyOpen, fullyOpen }` (a struct, not an enum, so we map with ==)
///   `DeviceHingeContext { var hinge: DeviceHinge? }`
///   `View.onHingeChange(isEnabled:_ action: (_ oldContext:, _ newContext:) -> Void)`
enum DuoPose: Equatable {
    case noHinge, closed, partiallyOpen, fullyOpen
}

extension View {
    /// Calls `action` with the current pose and hinge angle in degrees (nil when there is no hinge).
    /// Fires once on appear with the initial state, then on every hinge change.
    func onDuoPoseChange(_ action: @escaping (_ pose: DuoPose, _ hingeAngleDegrees: Double?) -> Void) -> some View {
        modifier(DuoPoseModifier(action: action))
    }
}

private struct DuoPoseModifier: ViewModifier {
    let action: (DuoPose, Double?) -> Void

    func body(content: Content) -> some View {
        if #available(iOS 27.1, *) {
            content.modifier(HingePoseModifier(action: action))
        } else {
            content.onAppear { action(.noHinge, nil) }
        }
    }
}

@available(iOS 27.1, *)
private struct HingePoseModifier: ViewModifier {
    let action: (DuoPose, Double?) -> Void
    @State private var sawHinge = false

    func body(content: Content) -> some View {
        content
            // The interface has no `initial:` flag, so onHingeChange may only report
            // changes. If it hasn't fired by the time we appear, report .noHinge once so
            // consumers get an initial state; never let that override a real reading.
            .onAppear { if !sawHinge { action(.noHinge, nil) } }
            .onHingeChange { _, new in
                sawHinge = true
                let (pose, degrees) = Self.map(new)
                action(pose, degrees)
            }
    }

    static func map(_ context: DeviceHingeContext) -> (DuoPose, Double?) {
        guard let hinge = context.hinge else { return (.noHinge, nil) }
        let pose: DuoPose
        switch hinge.status {
        case .closed: pose = .closed
        case .fullyOpen: pose = .fullyOpen
        default: pose = .partiallyOpen
        }
        return (pose, hinge.angle.degrees)
    }
}
