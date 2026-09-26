import SwiftUI

/// Folding the iPhone Duo sets the cut tilt (PRD A2):
/// hinge degrees -> HingeMapping.tilt (clamp 90...180, tilt = 180 - angle)
///               -> HingeSmoother (light EMA) -> setTilt.
/// Closed or no hinge keeps the last tilt; it never snaps back to a default.
///
/// SwiftUI's hinge API is a view modifier, not an object you can start/stop, so the
/// data enters through `ingest(pose:hingeAngleDegrees:)`, wired by `.hingeTiltDriver(_:)`.
/// `start()`/`stop()` gate whether ingested samples move the tilt.
@MainActor
@Observable
final class HingeTiltDriver {
    private(set) var pose: DuoPose = .noHinge
    private(set) var lastHingeAngle: Double?
    private(set) var lastTilt: Double?
    /// Band index that changes exactly when the tilt lands on 0 or crosses 30/60/90;
    /// `.hingeTiltDriver(_:)` plays a selection haptic on each change.
    private(set) var detent: Int?

    var isHingeAvailable: Bool { pose != .noHinge }

    @ObservationIgnored private var setTilt: ((Double) -> Void)?
    @ObservationIgnored private var smoother = HingeSmoother()
    @ObservationIgnored private var target: Double?
    @ObservationIgnored private var settleTask: Task<Void, Never>?
    @ObservationIgnored private(set) var isRunning = false

    init() {}

    func bind(_ setTilt: @escaping (Double) -> Void) { self.setTilt = setTilt }

    /// Starts moving the tilt. Replays the latest reading, in case the hinge reported
    /// before start() ran (onAppear ordering between modifiers is not guaranteed).
    func start() {
        guard !isRunning else { return }
        isRunning = true
        ingest(pose: pose, hingeAngleDegrees: lastHingeAngle)
    }

    func stop() {
        isRunning = false
        settleTask?.cancel()
        settleTask = nil
    }

    func ingest(pose: DuoPose, hingeAngleDegrees: Double?) {
        self.pose = pose
        if let hingeAngleDegrees { lastHingeAngle = hingeAngleDegrees }
        guard isRunning else { return }
        // A2: closed or unavailable -> keep the last tilt, manual control takes over.
        guard pose == .partiallyOpen || pose == .fullyOpen, let degrees = hingeAngleDegrees else { return }
        target = HingeMapping.tilt(forHingeAngle: degrees)
        step()
        scheduleSettle()
    }

    // MARK: - Private

    /// One smoother step toward the current target, then publish.
    private func step() {
        guard let target else { return }
        var tilt = smoother.update(target)
        if abs(tilt - target) < 0.05 { tilt = target }
        publish(tilt)
    }

    /// Hinge callbacks stop when the lid stops, so an event-driven EMA would park short of
    /// the target. Keep stepping at ~60 Hz until it lands (about 12 frames at alpha 0.35).
    private func scheduleSettle() {
        guard settleTask == nil else { return }
        settleTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(16))
                guard let self, !Task.isCancelled else { return }
                guard let target = self.target, let last = self.lastTilt, last != target else {
                    self.settleTask = nil
                    return
                }
                self.step()
            }
        }
    }

    private func publish(_ tilt: Double) {
        lastTilt = tilt
        let band = tilt <= 0 ? 0 : min(Int(tilt / 30), 3) + 1   // 0 | (0,30) | [30,60) | [60,90) | 90
        if band != detent { detent = band }
        setTilt?(tilt)
    }
}

extension View {
    /// Wires the Duo hinge into `driver` and starts it while this view is on screen.
    /// Adds a selection haptic when the tilt crosses 0/30/60/90 degrees.
    func hingeTiltDriver(_ driver: HingeTiltDriver) -> some View {
        self
            .onDuoPoseChange { pose, degrees in
                driver.ingest(pose: pose, hingeAngleDegrees: degrees)
            }
            .onAppear { driver.start() }
            .onDisappear { driver.stop() }
            .sensoryFeedback(.selection, trigger: driver.detent) { old, new in
                old != nil && new != nil
            }
    }
}
