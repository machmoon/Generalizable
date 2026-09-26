#!/bin/zsh
# DEMO ONLY. Pack a file or directory into <95 MB chunks so GitHub accepts it without LFS.
# Usage: ./pack.sh <source path> <asset name>
#   -> assets/<name>/<name>.tar.part-000, -001, ... plus <name>.sha256 (of the full tar)
# Restore: ./unpack.sh <asset name> <destination dir>
set -euo pipefail
src=$1; name=$2
out="${0:A:h}/assets/$name"
rm -rf "$out"; mkdir -p "$out"
tar -C "${src:h}" -cf - "${src:t}" | tee >(shasum -a 256 | cut -d' ' -f1 > "$out/$name.sha256") \
  | split -b 95m -a 3 -d - "$out/$name.tar.part-"
sleep 1
echo "$name: $(ls "$out" | grep -c part-) parts, $(du -sh "$out" | cut -f1)"
