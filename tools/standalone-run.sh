#!/bin/zsh
# Tests the standalone repair entry points against the packaged app.
#   zsh tools/standalone-run.sh <broken.3mf> <clean.3mf>
#
#   1. start screen  -> "Repair a 3MF file…" -> saved copy, nothing loaded -> Open in app
#                    -> toolbar "Repair" on the now-clean model ("No problems found")
#   2. broken model loaded -> toolbar "Repair" -> repaired model replaces it
#   3. clean model loaded  -> toolbar "Repair" -> "No problems found", model kept
set -u
cd "${0:A:h}/.."
APP="$PWD/dist/Multipart3D Local-darwin-arm64/Multipart3D.app"
BIN="$APP/Contents/MacOS/Multipart3D"
RES="$APP/Contents/Resources/app"
OUT=$(mktemp -d /tmp/mp3dsa.XXXX)/out_repaired.3mf
pretty() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const l of s.split("\n")){if(l.startsWith("STANDALONE "))console.log(JSON.stringify(JSON.parse(l.slice(11)),null,1));else if(l.trim())console.log(l)}})'; }

echo "########## 1. start screen file repair + toolbar on clean result"
LOG="${OUT:h}/run1.log"
MP3D_SMOKE=1 MP3D_TEST_STANDALONE=1 MP3D_TEST_PICK_IN="$1" MP3D_TEST_PICK_OUT="$OUT" MP3D_MAXIMIZE=1 "$BIN" > "$LOG" 2>&1
echo "  (exit $?, log $LOG)"
grep -E '^STANDALONE|renderer:3' "$LOG" | pretty

for pair in "2:$1" "3:$2"; do
  n=${pair%%:*}; f=${pair#*:}
  echo "########## $n. toolbar Repair on loaded $(basename "$f")"
  cp "$f" "$RES/site/__smoke.3mf"
  LOG="${OUT:h}/run$n.log"
  MP3D_SMOKE=1 MP3D_SMOKE_FILE=__smoke.3mf MP3D_TEST_STANDALONE=1 MP3D_MAXIMIZE=1 "$BIN" > "$LOG" 2>&1
  echo "  (exit $?, log $LOG)"
  grep -E '^STANDALONE|renderer:3' "$LOG" | pretty
  rm -f "$RES/site/__smoke.3mf"
done
# logs kept in ${OUT:h}
