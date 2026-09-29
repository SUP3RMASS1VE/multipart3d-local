/** Confirms the new printer is selectable and its build volume applies. */
(async () => {
  const clickByText = (sel, text) => {
    const el = [...document.querySelectorAll(sel)].find(
      (n) => (n.innerText || n.textContent || '').trim().toLowerCase() === text.toLowerCase()
    );
    if (el) el.click();
    return !!el;
  };
  const clickContains = (sel, text) => {
    const el = [...document.querySelectorAll(sel)].find((n) =>
      (n.innerText || n.textContent || '').toLowerCase().includes(text.toLowerCase())
    );
    if (el) el.click();
    return !!el;
  };

  const beforeText = document.body.innerText || '';
  const printerBefore = (beforeText.match(/PRINTER\s*\n?\s*([^\n]+)/) || [])[1] || null;

  const openedDropdown = clickContains('button,[role=button]', printerBefore || 'Printer');
  await new Promise((r) => setTimeout(r, 500));

  // Dump what actually appeared, so a failed click is diagnosable.
  const optionsAfterOpen = [...document.querySelectorAll('li,[role=option],button,div')]
    .map((n) => (n.innerText || '').trim())
    .filter((t) => t && t.length > 0 && t.length < 40 && !t.includes('\n\n'))
    .filter((t, i, arr) => arr.indexOf(t) === i) // dedupe (nested elements repeat text)
    .slice(0, 60);

  const target = (globalThis.__mp3dProbeTarget || 'kobra s1 max').toLowerCase();
  const hasKobraS1 = optionsAfterOpen.some((t) => t.toLowerCase().includes(target));

  let clicked = false;
  if (hasKobraS1) {
    // Custom listbox rows often listen for pointerdown/mousedown rather than
    // (or in addition to) click, so dispatch the full real sequence.
    const row = [...document.querySelectorAll('li,[role=option],button,div')].find((n) =>
      (n.innerText || '').toLowerCase().includes(target)
    );
    if (row) {
      const r = row.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        row.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      }
      clicked = true;
    }
  }
  await new Promise((r) => setTimeout(r, 800));

  const afterText = document.body.innerText || '';
  const printerLine = (afterText.match(/PRINTER\s*\n?\s*([^\n]+)/) || [])[1] || null;
  const volLine = (afterText.match(/BUILD VOLUME\s*\n?\s*([^\n]+)/) || [])[1] || null;

  return { printerBefore, openedDropdown, optionsAfterOpen, hasKobraS1, clicked, printerLine, volLine };
})();
