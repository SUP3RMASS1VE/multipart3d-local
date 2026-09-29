#!/bin/zsh
# Checks an exported parts zip from a painted model:
#   1. per-part paint histogram in what WE wrote
#   2. Bambu Studio loads each part and its own re-export still has the paint
#      and the source project's filament colours
#
#   zsh tools/verify-color-export.sh <parts.zip> [source.3mf]
set -u
# Resolve here: inside a zsh function $0 is the function name, not the script.
TOOLS="${0:A:h}"
zipf="$1"; src="${2:-}"
work=$(mktemp -d /tmp/mp3dverify.XXXX)
unzip -q "$zipf" -d "$work/parts"

hist() {  # paint histogram of a 3mf
  node "$TOOLS/paint-hist.cjs" "$1"
}
cfgcolours() {
  unzip -p "$1" Metadata/project_settings.config 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.stringify(JSON.parse(s).filament_colour))}catch(e){console.log("none")}})'
}

if [ -n "$src" ]; then
  echo "SOURCE  paint: $(hist "$src")"
  echo "SOURCE  filament_colour: $(cfgcolours "$src")"
fi

for p in "$work"/parts/*.3mf; do
  n=$(basename "$p")
  echo "=== $n"
  echo "  ours   tris: $(unzip -p "$p" 3D/3dmodel.model | grep -o '<triangle ' | wc -l | tr -d ' ')   paint: $(hist "$p")"
  echo "  ours   filament_colour: $(cfgcolours "$p")"
  out="$work/rt-$n"
  /Applications/BambuStudio.app/Contents/MacOS/BambuStudio --debug 1 --export-3mf "$out" "$p" > "$work/log-$n.txt" 2>&1
  rc=$?
  if [ $rc -ne 0 ] || [ ! -f "$out" ]; then
    echo "  BAMBU  FAILED to load (exit $rc)"; grep -i error "$work/log-$n.txt" | head -3
    continue
  fi
  echo "  bambu  paint: $(hist "$out")"
  echo "  bambu  filament_colour: $(cfgcolours "$out")"
done
rm -rf "$work"
