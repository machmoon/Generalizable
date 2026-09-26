// DuoHingeSource.swift
// Lane L3c-duo-hinge (PRD A3/A9): the real iPhone Duo hinge behind `HingeAngleSource`.
//
// API (iOS 27.1 SDK, UIKit/UIHinge.h + UIHingeInteraction.h):
//   UIHingeInteraction(updateHandler:) delivers the initial state and every change.
//   update.hinge == nil       -> the view left a hierarchy that has a hinge (no value; A2 keeps the last tilt).
//   hinge.angle               -> CGFloat, RADIANS. Converted to degrees here, because HingeMapping takes degrees.
//   hinge.status == .closed   -> no value is reported, so the tilt holds (A2: never snap back).
//
// onAngle reports the raw hinge angle in degrees. Callers map it with
// HingeMapping.tilt(forHingeAngle:) and smooth it with HingeSmoother.

import Foundation
import UIKit

/// Returns the Duo hinge source on iOS 27.1+, otherwise the manual-only stub (A3).
enum HingeSources {
    static func makeDefault() -> HingeAngleSource {
        if #available(iOS 27.1, *) {
            return DuoHingeSource()
        }
        return ManualOnlyHingeSource()
    }
}

@available(iOS 27.1, *)
final class DuoHingeSource: HingeAngleSource {
    var onAngle: ((Double) -> Void)?

    /// Last raw hinge angle in degrees, for the "Hinge x° → Tilt y°" readout.
    private(set) var lastAngleDegrees: Double?
    /// True once the system has delivered a hinge for this hierarchy.
    private(set) var isHingeAvailable = false

    private var interaction: UIHingeInteraction?
    private weak var hostView: UIView?
    private var running = false

    /// Attaches to the key window's root view, so no SwiftUI view needs changing.
    /// If no window exists yet (called from an early onAppear), retries on the next run-loop turn.
    func start() {
        running = true
        DispatchQueue.main.async { [weak self] in self?.attach(retries: 20) }
    }

    func stop() {
        running = false
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let interaction = self.interaction {
                self.hostView?.removeInteraction(interaction)
            }
            self.interaction = nil
            self.hostView = nil
        }
    }

    @MainActor
    private func attach(retries: Int) {
        guard running, interaction == nil else { return }
        guard let view = Self.keyRootView() else {
            if retries > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                    self?.attach(retries: retries - 1)
                }
            }
            return
        }
        let interaction = UIHingeInteraction { [weak self] _, update in
            self?.handle(update)
        }
        view.addInteraction(interaction)
        self.interaction = interaction
        self.hostView = view
    }

    @MainActor
    private func handle(_ update: UIHingeInteraction.Update) {
        guard running, let hinge = update.hinge else { return }
        isHingeAvailable = true
        guard hinge.status != .closed else { return }
        let degrees = Double(hinge.angle) * 180 / .pi
        lastAngleDegrees = degrees
        onAngle?(degrees)
    }

    @MainActor
    private static func keyRootView() -> UIView? {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
        let window = windows.first(where: \.isKeyWindow) ?? windows.first
        return window?.rootViewController?.view ?? window
    }
}
