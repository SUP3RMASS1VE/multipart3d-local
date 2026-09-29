/**
 * Enters Area Cut and reports the draggable controls with their screen rects,
 * so the profiler can drive the exact interaction that lags: moving the cut
 * window.
 */
(async () => {
  const clickByText = (text) => {
    const el = [...document.querySelectorAll('button,[role=button]')].find((b) =>
      (b.innerText || b.getAttribute('aria-label') || '').trim().toLowerCase().startsWith(text)
    );
    if (el) el.click();
    return !!el;
  };

  const opened = clickByText('area cut');
  await new Promise((r) => setTimeout(r, 2500));

  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  };

  // Label each slider by the nearest preceding text in its row.
  const sliders = [...document.querySelectorAll('input[type=range]')].map((el) => {
    let label = '';
    let node = el.parentElement;
    for (let i = 0; i < 4 && node && !label; i++) {
      const t = (node.innerText || '').trim().split('\n')[0];
      if (t) label = t;
      node = node.parentElement;
    }
    return {
      label: label.slice(0, 24),
      min: el.min,
      max: el.max,
      value: el.value,
      step: el.step,
      ...rect(el),
    };
  });

  const numbers = [...document.querySelectorAll('input[type=number],input[type=text]')]
    .slice(0, 12)
    .map((el) => ({ value: el.value, ...rect(el) }));

  const canvas = document.querySelector('canvas');

  return {
    opened,
    canvas: canvas ? rect(canvas) : null,
    sliders,
    numbers,
    buttons: [...document.querySelectorAll('button')]
      .map((b) => (b.innerText || '').trim().replace(/\s+/g, ' '))
      .filter(Boolean)
      .slice(0, 40),
  };
})();
