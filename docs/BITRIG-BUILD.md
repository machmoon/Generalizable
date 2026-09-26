# What Bitrig builds

Bitrig builds the repo-root `Project.json` (XcodeGen). Since 2026-09-26 it builds the **Generalizable app in `ios/Generalizable`** (formerly "Lumen"), with Bitrig's bundle id `app.bitrig.new.8dc46b5e-…` so Bitrig's signing is unchanged.

## Switching back (reversible)

| Want | Do |
|---|---|
| Bitrig builds the previous `App/` FoldScan app again | `cp Project.app-foldscan.json Project.json`, commit, push |
| The exact repo state from before the switch | `git checkout bitrig-app-foldscan` (tag) |
| Build the Lumen app with its own spec (dev bundle id `dev.patliu.generalizable`) | `DEVELOPER_DIR=~/Downloads/Xcode.app/Contents/Developer ios/build.sh` |

Local check of what Bitrig will build: `SIM_DEVICE="iPhone Duo" scripts/build_sim.sh shot.png -openCase CQ500_CT_243 -gzHinge 118` (needs Xcode 27.1).
