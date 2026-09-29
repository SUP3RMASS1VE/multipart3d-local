#!/bin/zsh
# Checks every part in an exported parts zip: mesh closed (0 open / non-manifold
# edges), paint present, and size.
#   zsh tools/check-parts-zip.sh <parts.zip>
set -u
TOOLS="${0:A:h}"
w=$(mktemp -d /tmp/mp3dcz.XXXX)
unzip -q "$1" -d "$w"
for p in "$w"/*.3mf; do
  diag=$(node --max-old-space-size=8000 "$TOOLS/mesh-diag.mjs" "$p" | sed -n 2p)
  paint=$(node "$TOOLS/paint-hist.cjs" "$p")
  node -e '
    const d = JSON.parse(process.argv[1]);
    console.log(`${process.argv[3].padEnd(22)} tris=${String(d.triangles).padStart(8)} open=${d.boundaryEdges} nonManifold=${d.nonManifoldEdges} conflicts=${d.orientationConflicts} pieces=${d.components} | ${process.argv[2]}`);
  ' "$diag" "$paint" "$(basename "$p")"
done
rm -rf "$w"
