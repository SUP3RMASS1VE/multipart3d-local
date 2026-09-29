#!/bin/zsh
# End-to-end in-app repair test.
#   zsh tools/repair-run.sh <broken.3mf> <logfile> [app-binary]
set -u
cd "${0:A:h}/.."
bin="${3:-}"
if [ -n "$bin" ]; then
  res="${bin:h:h}/Resources/app"
  cp "$1" "$res/site/__smoke.3mf"
  MP3D_SMOKE=1 MP3D_SMOKE_FILE=__smoke.3mf MP3D_TEST_REPAIR=1 MP3D_MAXIMIZE=1 "$bin" > "$2" 2>&1
  rm -f "$res/site/__smoke.3mf"
else
  cp "$1" site/__smoke.3mf
  MP3D_SMOKE=1 MP3D_SMOKE_FILE=__smoke.3mf MP3D_TEST_REPAIR=1 MP3D_MAXIMIZE=1 npx electron . > "$2" 2>&1
  rm -f site/__smoke.3mf
fi
grep -E '^REPAIR_|^DOWNLOAD_DONE|renderer:3|mp3d-color' "$2" | cut -c1-1500
