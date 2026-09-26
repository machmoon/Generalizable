#!/bin/zsh
# Reassemble and verify an asset made by pack.sh.
# Usage: ./unpack.sh <asset name> <destination dir>
set -euo pipefail
name=$1; dest=$2
dir="${0:A:h}/assets/$name"
mkdir -p "$dest"
sum=$(cat "$dir"/$name.tar.part-* | tee >(tar -C "$dest" -xf -) | shasum -a 256 | cut -d' ' -f1)
[[ $sum == $(cat "$dir/$name.sha256") ]] && echo "$name OK -> $dest" || { echo "$name CHECKSUM MISMATCH"; exit 1; }
