/**
 * Site-wide screen lock: nothing can be selected, copied, cut or dragged out,
 * there is no right-click menu, and the save, print, view-source and
 * developer-tool shortcuts do nothing. Text fields stay fully usable (select,
 * copy and paste what you type), and an element marked `data-allow-copy`
 * (e.g. a machine credential shown only once) can be selected and copied.
 * index.css sets the matching `user-select` rules.
 *
 * These deter casual copying only: anything a browser shows can still be
 * saved by someone determined. The real protections are the security headers
 * in infra/docker/Caddyfile and the logins in front of every staff page.
 */

/** F12, or Ctrl/Cmd with Shift or Option plus I, J, C, K, E or M: developer tools. */
const DEVTOOLS_KEYS = new Set(['KeyI', 'KeyJ', 'KeyC', 'KeyK', 'KeyE', 'KeyM']);
/** Ctrl/Cmd + U (view source), S (save page), P (print). */
const PAGE_KEYS = new Set(['KeyU', 'KeyS', 'KeyP']);
/** Ctrl/Cmd + A (select all), C (copy), X (cut): allowed only while typing in a field. */
const EDIT_KEYS = new Set(['KeyA', 'KeyC', 'KeyX']);

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const COPYABLE = `${EDITABLE}, [data-allow-copy]`;

function inside(node: EventTarget | Node | null, selector: string): boolean {
  if (!(node instanceof Node)) return false;
  const el = node instanceof Element ? node : node.parentElement;
  return el?.closest(selector) != null;
}

const editingNow = () => inside(document.activeElement, EDITABLE);

/** A selection made entirely inside data-allow-copy elements. */
function copyableSelection(): boolean {
  const s = document.getSelection();
  return !!s && !s.isCollapsed && inside(s.anchorNode, '[data-allow-copy]') && inside(s.focusNode, '[data-allow-copy]');
}

/** Installs the lock on the whole document; returns a function that removes it. */
export function installScreenLock(): () => void {
  const block = (e: Event) => e.preventDefault();
  const onSelectStart = (e: Event) => {
    if (!inside(e.target, COPYABLE)) e.preventDefault();
  };
  const onCopyCut = (e: Event) => {
    if (!editingNow() && !copyableSelection()) e.preventDefault();
  };
  // Catches selections made another way (the browser's Edit menu, a double tap).
  const onSelectionChange = () => {
    if (editingNow()) return;
    const s = document.getSelection();
    if (s && !s.isCollapsed && !copyableSelection()) s.removeAllRanges();
  };
  const onKey = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    const plain = mod && !e.shiftKey && !e.altKey;
    const devtools = e.code === 'F12' || (mod && (e.shiftKey || e.altKey) && DEVTOOLS_KEYS.has(e.code));
    const pageAction = plain && PAGE_KEYS.has(e.code);
    const editAction = plain && EDIT_KEYS.has(e.code) && !editingNow() && !(e.code === 'KeyC' && copyableSelection());
    if (devtools || pageAction || editAction) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  document.addEventListener('contextmenu', block);
  document.addEventListener('dragstart', block);
  document.addEventListener('selectstart', onSelectStart);
  document.addEventListener('copy', onCopyCut);
  document.addEventListener('cut', onCopyCut);
  document.addEventListener('selectionchange', onSelectionChange);
  window.addEventListener('keydown', onKey, true);
  return () => {
    document.removeEventListener('contextmenu', block);
    document.removeEventListener('dragstart', block);
    document.removeEventListener('selectstart', onSelectStart);
    document.removeEventListener('copy', onCopyCut);
    document.removeEventListener('cut', onCopyCut);
    document.removeEventListener('selectionchange', onSelectionChange);
    window.removeEventListener('keydown', onKey, true);
  };
}
