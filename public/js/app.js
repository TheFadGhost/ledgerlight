import { api, loadSettings, toast, announce } from './lib.js';

const routes = {
  dashboard: () => import('./pages/dashboard.js'),
  transactions: () => import('./pages/transactions.js'),
  import: () => import('./pages/import.js'),
  budgets: () => import('./pages/budgets.js'),
  settings: () => import('./pages/settings.js'),
  rules: () => import('./pages/rules.js'),
};

const view = document.getElementById('view');

function currentRoute() {
  const name = location.pathname.replace(/^\//, '').split('/')[0] || 'dashboard';
  return routes[name] ? name : 'dashboard';
}

function setActiveNav(name) {
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const active = a.dataset.nav === name;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

let renderToken = 0;

export async function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  await render();
}

export function refresh() {
  return render();
}

async function render() {
  const token = ++renderToken;
  const name = currentRoute();
  setActiveNav(name);
  view.innerHTML = '';
  view.append(skeleton());
  try {
    const mod = await routes[name]();
    if (token !== renderToken) return; // superseded by newer navigation
    view.innerHTML = '';
    await mod.render(view);
    view.focus({ preventScroll: true });
  } catch (err) {
    if (token !== renderToken) return;
    view.innerHTML = '';
    view.append(
      Object.assign(document.createElement('div'), { className: 'error-panel' }),
    );
    const panel = view.querySelector('.error-panel');
    panel.textContent = `Something went wrong loading ${name}: ${err.message}`;
  }
}

function skeleton() {
  const s = document.createElement('div');
  s.className = 'skeleton-wrap';
  for (let i = 0; i < 4; i += 1) {
    const bar = document.createElement('div');
    bar.className = 'skeleton-bar';
    s.append(bar);
  }
  return s;
}

window.addEventListener('popstate', render);

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-nav]');
  if (!a) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});

async function undoLast() {
  try {
    const res = await api('/undo', { method: 'POST' });
    if (res.undone === null) {
      toast('Nothing left to undo', 'info');
    } else {
      toast(`Undid: ${res.undone.replace('_', ' ')}`, 'success');
      announce(`Undid ${res.undone}`);
      render();
    }
  } catch (err) {
    toast(err.message || 'Undo failed', 'error');
  }
}

document.getElementById('undo-btn').addEventListener('click', undoLast);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    e.preventDefault();
    undoLast();
  }
});

// Boot asynchronously: module evaluation must finish synchronously because
// pages/import.js statically imports { navigate } from this module — a
// top-level await here would deadlock that circular import.
async function boot() {
  await loadSettings().catch(() => {});
  await render();
}

function renderFatalError(err) {
  view.innerHTML = '';
  const panel = Object.assign(document.createElement('div'), { className: 'error-panel' });
  panel.textContent = `Ledgerlight failed to start: ${err.message}`;
  view.append(panel);
}

boot().catch((err) => {
  console.error('Boot failed:', err);
  renderFatalError(err);
});
