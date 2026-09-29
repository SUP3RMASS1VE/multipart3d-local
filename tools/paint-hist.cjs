// Paint histogram of a 3MF, streaming each .model entry through `unzip -p` so
// multi-hundred-MB models do not have to fit in one JS string.
//   node tools/paint-hist.cjs file.3mf
const { execFileSync, spawn } = require('child_process');
const f = process.argv[2];
const models = execFileSync('unzip', ['-Z1', f]).toString().split('\n').filter((e) => e.endsWith('.model'));

const counts = new Map();
let tris = 0;
let carry = '';

function scan(text) {
  const re = /<triangle\b([^>]*)>/g;
  let m;
  let last = 0;
  while ((m = re.exec(text))) {
    tris++;
    const p = /paint_color="([^"]*)"/.exec(m[1]);
    const k = p ? p[1] : '(none)';
    counts.set(k, (counts.get(k) || 0) + 1);
    last = re.lastIndex;
  }
  return last;
}

(async () => {
  for (const m of models) {
    await new Promise((resolve, reject) => {
      const p = spawn('unzip', ['-p', f, m]);
      p.stdout.setEncoding('utf8');
      p.stdout.on('data', (chunk) => {
        const text = carry + chunk;
        const consumed = scan(text);
        // Keep any unfinished tag for the next chunk. Cut at the last '<', not
        // the last '<triangle': a chunk can end mid-word ("<trian"), and
        // searching for the full word would silently drop that triangle.
        const tail = text.slice(consumed);
        const open = tail.lastIndexOf('<');
        carry = open >= 0 ? tail.slice(open) : '';
      });
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('unzip ' + code))));
    });
    carry = '';
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]);
  const painted = tris - (counts.get('(none)') || 0);
  console.log(
    `tris=${tris} painted=${painted} distinct=${counts.size} top=` +
      top.slice(0, 6).map(([k, v]) => `${k}:${v}`).join(' ')
  );
})();
