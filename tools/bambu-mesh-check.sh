#!/bin/zsh
# Loads a 3MF in Bambu Studio's CLI and prints Bambu's own mesh stats
# (open edges, non-manifold edges, reversed faces). Works on a throwaway copy
# with two known-bad line-width settings reset, so projects whose config
# Bambu's CLI rejects can still be checked. The input file is not modified.
#   zsh tools/bambu-mesh-check.sh <file.3mf> [label]
set -u
B=/Applications/BambuStudio.app/Contents/MacOS/BambuStudio
f="$1"; tag="${2:-${1:t}}"
w=$(mktemp -d /tmp/mp3dbc.XXXX)
cp "$f" "$w/in.3mf"
if unzip -l "$w/in.3mf" Metadata/project_settings.config >/dev/null 2>&1; then
  ( cd "$w" && unzip -q -o in.3mf Metadata/project_settings.config && node -e '
    const fs=require("fs"),p="Metadata/project_settings.config";
    const j=JSON.parse(fs.readFileSync(p,"utf8"));
    for (const k of ["skin_infill_line_width","skeleton_infill_line_width"]) if (k in j && parseFloat(j[k])>10) j[k]="0.42";
    fs.writeFileSync(p, JSON.stringify(j,null,4));' && zip -q in.3mf Metadata/project_settings.config )
fi
$B --debug 3 --export-3mf "$w/rt.3mf" "$w/in.3mf" > "$w/log.txt" 2>&1
rc=$?
stats=$(grep -o 'mesh-stats faces=[^ ]* verts=[^ ]* parts=[^ ]* volume=[^ ]* open_edges=[^ ]* nm_edges=[^ ]* nm_verts=[^ ]* has_reversed_faces=[^ ]*' "$w/log.txt" | head -1)
echo "$tag: bambu exit $rc | ${stats:-no mesh stats (see $w/log.txt)}"
[ -n "$stats" ] && rm -rf "$w"
