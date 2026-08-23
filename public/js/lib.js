// Shared frontend helpers — the only sanctioned way to reach the API, format
// money, build DOM, toast, announce, and open dialogs.

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error(data?.message || `Request failed (${res.status})`);
    err.code = data?.error || 'ERROR';
    err.details = data?.details;
    throw err;
  }
  return data;
}

let settings = null;

export async function loadSettings() {
  settings = await api('/settings');
  applyTheme(settings.theme);
  return settings;
}

export function getSettings() {
  return settings;
}

export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

/** Format integer minor units per user settings. Negatives are parentheses. */
export function fmtMoney(minor) {
  const d = settings?.display ?? {};
  // Lazy local copy of server formatMoney contract; integers only.
  const symbol = d.symbol ?? '$';
  const side = d.symbolSide ?? 'left';
  const group = d.groupSeparator ?? ',';
  const dec = d.decimalSeparator ?? '.';
  const digits = d.decimalDigits ?? 2;
  if (!Number.isInteger(minor)) return String(minor);
  const abs = Math.abs(minor);
  const div = 10 ** digits;
  const intPart = Math.floor(abs / div).toString();
  const fracPart = (abs % div).toString().padStart(digits, '0');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const num = digits > 0 ? `${grouped}${dec}${fracPart}` : grouped;
  const body = side === 'left' ? `${symbol} ${num}` : `${num} ${symbol}`;
  return minor < 0 ? `(${body})` : body;
}

export function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d} ${MONTHS_SHORT[+m - 1]} ${y}`;
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Tiny DOM builder: el('div.card', {onclick}, children...) */
export function el(spec, attrs = {}, ...children) {
  const [tag, ...classes] = spec.split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k in node && k !== 'style' && k !== 'list') { try { node[k] = v; } catch { node.setAttribute(k, v); } }
    else node.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function toast(message, kind = 'info', action = null) {
  const box = document.getElementById('toasts');
  const t = el('div.toast', { class: `toast ${kind}` },
    el('span', {}, message),
    action ? el('button.btn.btn-ghost', {
      type: 'button',
      onclick: () => { action.onClick(); t.remove(); },
    }, action.label) : null,
    el('button.btn.btn-ghost.toast-close', { type: 'button', 'aria-label': 'Dismiss', onclick: () => t.remove() }, '\u00D7'),
  );
  box.append(t);
  setTimeout(() => t.remove(), action ? 8000 : 4500);
  return t;
}

export function announce(text) {
  const s = document.getElementById('sr-status');
  s.textContent = '';
  requestAnimationFrame(() => { s.textContent = text; });
}

/** Focus-trapped dialog. Returns {close}. Esc closes. */
export function openDialog({ title, content, onClose }) {
  const root = document.getElementById('dialog-root');
  const prevFocus = document.activeElement;
  const overlay = el('div.dialog-overlay', { tabindex: '-1' },
    el('div.dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      el('div.dialog-head', {},
        el('h2', {}, title),
        el('button.btn.btn-ghost.dialog-x', { type: 'button', 'aria-label': 'Close dialog', onclick: close }, '\u00D7')),
      content),
  );
  function trap(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const focusables = overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  }
  function close() {
    overlay.remove();
    document.removeEventListener('keydown', trap, true);
    if (prevFocus?.focus) prevFocus.focus();
    onClose?.();
  }
  document.addEventListener('keydown', trap, true);
  root.append(overlay);
  const dialog = overlay.querySelector('.dialog');
  // Focus priority: first form field, else first actionable button (skipping
  // toast dismiss and the dialog's own close button), else the overlay.
  const focusable = (nodes) => nodes.find((n) => !n.disabled
    && n.type !== 'hidden' && !n.closest('[hidden]')) ?? null;
  const firstField = focusable([...dialog?.querySelectorAll('input, select, textarea') ?? []]);
  const firstButton = focusable([...dialog?.querySelectorAll('button:not(.toast-close):not(.dialog-x)') ?? []]);
  (firstField ?? firstButton ?? overlay).focus();
  return { close };
}

/** Confirm a destructive action. Resolves true when confirmed. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm' }) {
  return new Promise((resolve) => {
    const { close } = openDialog({
      title,
      onClose: () => resolve(false),
      content: el('div', {},
        el('p', {}, message),
        el('div.dialog-actions', {},
          el('button.btn', { type: 'button', onclick: () => { close(); } }, 'Cancel'),
          el('button.btn.btn-danger', {
            type: 'button',
            onclick: () => { resolve(true); close(); },
          }, confirmLabel),
        )),
    });
  });
}
