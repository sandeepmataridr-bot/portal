/**
 * On phones, `.data-table` rows are shown as cards, one "label: value" line
 * per cell (index.css). The label comes from the cell's `data-label`, which
 * this fills in from the column headings for every table the app renders,
 * now or later, so no page has to repeat its headings. Cells that already
 * carry a `data-label`, or span several columns (an empty-state row), are
 * left alone.
 */
function labelTable(table: HTMLTableElement) {
  const headings = Array.from(table.querySelectorAll<HTMLTableCellElement>(':scope > thead > tr > th'), (th) =>
    (th.textContent ?? '').trim(),
  );
  if (!headings.length) return;
  for (const row of Array.from(table.querySelectorAll<HTMLTableRowElement>(':scope > tbody > tr'))) {
    let column = 0;
    for (const cell of Array.from(row.cells)) {
      if (cell.colSpan === 1 && !cell.hasAttribute('data-label')) cell.dataset.label = headings[column] ?? '';
      column += cell.colSpan;
    }
  }
}

/** Labels every `.data-table` in the app now and whenever the page changes; returns a function that stops it. */
export function installTableLabels(): () => void {
  let queued = false;
  const run = () => {
    queued = false;
    // Only the signed-in app; the login page's table has its own phone layout.
    document.querySelectorAll<HTMLTableElement>('.app-shell table.data-table').forEach(labelTable);
  };
  const observer = new MutationObserver(() => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(run);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  run();
  return () => observer.disconnect();
}
