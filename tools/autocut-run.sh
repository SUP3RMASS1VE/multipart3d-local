#!/bin/zsh
# End-to-end auto-cut test through the real UI.
#   zsh tools/autocut-run.sh <model.3mf> <printer-preset-id> [scale] [app-binary]
# Prints the report; logs + exported zip path stay in the temp dir shown.
set -u
cd "${0:A:h}/.."
model="$1"; printer="$2"; scale="${3:-}"; bin="${4:-}"
work=$(mktemp -d /tmp/mp3dac.XXXX)
log="$work/run.log"
if [ -n "$bin" ]; then site="${bin:h:h}/Resources/app/site"; else site="site"; fi
cp "$model" "$site/__smoke.3mf"
if [ -n "$bin" ]; then launch=("$bin"); else launch=(npx electron .); fi
env MP3D_SMOKE=1 MP3D_SMOKE_FILE=__smoke.3mf MP3D_TEST_AUTOCUT=1 MP3D_AUTOCUT_EXPORT=1 \
  MP3D_AUTOCUT_PRINTER="$printer" ${scale:+MP3D_AUTOCUT_SCALE=$scale} MP3D_MAXIMIZE=1 \
  "${launch[@]}" > "$log" 2>&1
rm -f "$site/__smoke.3mf"
echo "log: $log"
grep -E '^DOWNLOAD_DONE|renderer:3|mp3d-color\] colour export failed' "$log" | cut -c1-300
grep -E '^AUTOCUT ' "$log" | sed 's/^AUTOCUT //' > "$work/report.json"
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const a = r.after || [];
console.log(JSON.stringify({
  printer: r.printerSet, button: r.button, before: r.before,
  setup: (r.setupText || "").split("\n").filter(Boolean),
  report: r.report && (({ skippedParts, ...x }) => ({ ...x, skipped: skippedParts }))(r.report),
  wallMs: r.wallMs, history: r.historyLength,
  parts: a.length, allFit: a.every(p => p.fits), appBadgeAllFit: a.every(p => p.appBadgeFits),
  paintedTrisTotal: a.reduce((s, p) => s + p.paintedTris, 0),
  labelsBefore: (r.before || []).reduce((h, p) => { for (const [k, v] of Object.entries(p.labelHistogram || {})) h[k] = (h[k] || 0) + v; return h; }, {}),
  labelsAfter: a.reduce((h, p) => { for (const [k, v] of Object.entries(p.labelHistogram || {})) h[k] = (h[k] || 0) + v; return h; }, {}),
  partsWithLabels: a.filter(p => p.hasLabels).length,
  largest: a.map(p => p.size).sort((x, y) => Math.max(...y) - Math.max(...x))[0],
  exportStats: r.exportStats && { exports: r.exportStats.exports, projectMode: r.exportStats.projectMode, plainMode: r.exportStats.plainMode },
  result: (r.resultText || "").split("\n").filter(Boolean),
}, null, 1));
' "$work/report.json"
