#!/bin/zsh
# Load a painted 3MF, planar-cut it, export all parts as 3MF.
#   zsh tools/color-run.sh <file.3mf> <logfile>
set -u
cd "${0:A:h}/.."
cp "$1" site/__smoke.3mf
MP3D_SMOKE=1 MP3D_SMOKE_FILE=__smoke.3mf MP3D_TEST_COLOR=1 MP3D_MAXIMIZE=1 npx electron . > "$2" 2>&1
rm -f site/__smoke.3mf
grep -E '^COLOR_|^DOWNLOAD_|mp3d-color|renderer:3' "$2" | cut -c1-700
