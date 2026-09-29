#!/bin/zsh
# End-to-end plates test: load, (auto-cut), arrange on plates, export one
# project 3MF, then let Bambu Studio's CLI slice EVERY plate of it.
#   zsh tools/plates-run.sh <model.3mf> <printer-preset> [scale] [cut=1] [app-binary]
# Slicing works on a throwaway copy with two known-bad line widths reset
# (some of the user's source projects carry 100 mm values Bambu's CLI rejects).
set -u
cd "${0:A:h}/.."
model="$1"; printer="$2"; scale="${3:-}"; cut="${4:-1}"; bin="${5:-}"
work=$(mktemp -d /tmp/mp3dplr.XXXX)
if [ -n "$bin" ]; then site="${bin:h:h}/Resources/app/site"; launch=("$bin"); else site="site"; launch=(npx electron .); fi
cp "$model" "$site/__smoke.3mf"
env MP3D_SMOKE=1 MP3D_SMOKE_FILE=__smoke.3mf MP3D_TEST_PLATES=1 MP3D_PLATES_PRINTER="$printer" \
  ${scale:+MP3D_PLATES_SCALE=$scale} MP3D_PLATES_CUT="$cut" MP3D_CAPTURE_PLATES="$work/plates.png" MP3D_MAXIMIZE=1 \
  "${launch[@]}" > "$work/run.log" 2>&1
rm -f "$site/__smoke.3mf"
echo "work: $work"
grep -E 'renderer:3|mp3d-project' "$work/run.log" | cut -c1-300
grep '^PLATES ' "$work/run.log" | sed 's/^PLATES //' > "$work/plates.json"
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(JSON.stringify(r,null,1))' "$work/plates.json" | head -60
proj=$(grep -o 'DOWNLOAD_DONE completed .*_plates.3mf' "$work/run.log" | sed 's/DOWNLOAD_DONE completed //' | tail -1)
[ -z "$proj" ] && { echo "NO PROJECT FILE"; exit 1; }
cp "$proj" "$work/project.3mf"
echo "project: $work/project.3mf ($(du -h "$work/project.3mf" | cut -f1))"
echo "plates in file: $(unzip -p "$work/project.3mf" Metadata/model_settings.config | grep -c '<plate>')"
echo "painted triangles in file: $(node tools/paint-hist.cjs "$work/project.3mf")"
# Slice every plate with Bambu.
cp "$work/project.3mf" "$work/slice.3mf"
( cd "$work" && unzip -q -o slice.3mf Metadata/project_settings.config && node -e '
  const fs=require("fs"),p="Metadata/project_settings.config";const j=JSON.parse(fs.readFileSync(p,"utf8"));
  for (const k of ["skin_infill_line_width","skeleton_infill_line_width"]) if (k in j && parseFloat(j[k])>10) j[k]="0.42";
  fs.writeFileSync(p, JSON.stringify(j,null,4));' && zip -q slice.3mf Metadata/project_settings.config )
mkdir -p "$work/gcode"
/Applications/BambuStudio.app/Contents/MacOS/BambuStudio --debug 1 --slice 0 --outputdir "$work/gcode" "$work/slice.3mf" > "$work/slice.log" 2>&1
echo "bambu slice exit: $?"
node -e '
const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
console.log("bambu:", r.error_string);
for (const p of r.sliced_plates||[]) console.log("  plate", p.id, "objects", (p.objects||[]).length, "filaments", (p.filaments||[]).map(f=>f.id).join(","), "time", Math.round(p.main_predication/60)+" min");
' "$work/gcode/result.json" 2>/dev/null || tail -5 "$work/slice.log"
ls "$work/gcode" | grep -c gcode | xargs echo "gcode files:"
