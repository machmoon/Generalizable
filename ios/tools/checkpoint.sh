#!/bin/zsh
# Commit + push ios/ to the fork, but only when the app builds, so the branch never breaks.
cd "$(dirname "$0")/../.."
if [[ -z "$(git status --porcelain ios)" ]]; then echo "$(date +%T) nothing new"; exit 0; fi
if ! ios/build.sh /tmp/lumen-dd-checkpoint | grep -q "BUILD SUCCEEDED"; then echo "$(date +%T) build failing, skipped"; exit 0; fi
git add ios
git commit -qm "Lumen: checkpoint $(date +%H:%M) ($(git diff --cached --name-only | wc -l | tr -d ' ') files)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -q origin swift-app && echo "$(date +%T) pushed $(git rev-parse --short HEAD)"
