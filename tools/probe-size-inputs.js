/**
 * Dumps the numeric inputs in the left TRANSFORM panel with surrounding label
 * text, so the profiler can target the Z size field the user actually edits.
 */
(() => {
  const inputs = [...document.querySelectorAll('input')];
  return inputs.map((el, i) => {
    const r = el.getBoundingClientRect();
    // Nearest label-ish text: previous siblings, then ancestor row text.
    const bits = [];
    let sib = el.previousElementSibling;
    for (let k = 0; k < 3 && sib; k++) {
      const t = (sib.innerText || sib.textContent || '').trim();
      if (t) bits.push('prev:' + t.slice(0, 16));
      sib = sib.previousElementSibling;
    }
    let node = el.parentElement;
    for (let k = 0; k < 3 && node; k++) {
      const t = (node.innerText || '').trim().replace(/\s+/g, ' ');
      if (t) bits.push('anc' + k + ':' + t.slice(0, 40));
      node = node.parentElement;
    }
    return {
      i,
      type: el.type,
      value: el.value,
      min: el.min || null,
      max: el.max || null,
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      w: Math.round(r.width),
      visible: r.width > 0 && r.height > 0,
      context: bits.join(' | ').slice(0, 120),
    };
  });
})();
