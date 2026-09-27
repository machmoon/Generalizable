#!/bin/zsh
# Usage: ./build.sh [derivedDataDir]  — builds Lumen for the iPhone Duo simulator.
set -e
cd "$(dirname "$0")"
xcodegen generate --quiet
DD=/tmp/lumen-dd  # single shared cache: parallel caches filled the disk
xcodebuild -project Lumen.xcodeproj -scheme Lumen -destination 'generic/platform=iOS Simulator' -derivedDataPath "$DD" build 2>&1 | grep -E "error:|warning: unre|BUILD (SUCCEEDED|FAILED)" | head -60
