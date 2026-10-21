import { MARK, PATIENT } from './format';
import { getSnapshot, subscribe } from './store';

/**
 * Full-screen "active alarms only" fallback, built with plain DOM and
 * textContent — no React — so it still works when the React tree has
 * crashed (plan §3.1). Shown by the page's error boundary and by uncaught
 * errors while the central station is open; keeps updating from the store.
 */
let root: HTMLDivElement | null = null;
let list: HTMLUListElement | null = null;
let unsubscribe: (() => void) | null = null;

function render() {
  if (!list) return;
  const s = getSnapshot().state;
  const alerts = s && s.ready ? s.alerts : [];
  const items = alerts.length
    ? alerts.map((a) => {
        const li = document.createElement('li');
        li.className = `fb-${a.priority}`;
        li.textContent =
          `${MARK[a.priority]} ${a.priority}  ${PATIENT(a.patientLabel, a.encounter)}  ${a.explanation}` +
          (a.acknowledgedBy ? `  (acknowledged by ${a.acknowledgedBy})` : '');
        return li;
      })
    : [Object.assign(document.createElement('li'), { textContent: 'No active alarms.' })];
  list.replaceChildren(...items);
}

export function showFallback(error: unknown): void {
  console.error('central station render failed', error);
  if (root) return;
  root = document.createElement('div');
  root.className = 'vigil-cs vigil-fallback';
  root.setAttribute('role', 'alertdialog');
  root.setAttribute('aria-labelledby', 'vigil-fallback-h');
  const h1 = Object.assign(document.createElement('h1'), {
    id: 'vigil-fallback-h',
    textContent: 'Display error: showing active alarms only',
  });
  const p = Object.assign(document.createElement('p'), {
    textContent: 'Part of the central station failed. Alarms below are still updating. Use the bedside devices and reload this page.',
  });
  const reload = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: 'Reload page' });
  reload.addEventListener('click', () => window.location.reload());
  list = document.createElement('ul');
  root.append(h1, p, reload, list);
  document.body.append(root);
  unsubscribe = subscribe(render);
  render();
}

export function hideFallback(): void {
  unsubscribe?.();
  unsubscribe = null;
  root?.remove();
  root = null;
  list = null;
}
