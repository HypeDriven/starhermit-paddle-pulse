// DOM shell framework (spec §3): semantic HTML screens over/beside the
// canvas, focus management with restoration, live regions for objective /
// turn / score / errors / results, toasts with invalid-action explanations.
// UI state is kept strictly separate from simulation state.

export class App {
  constructor({ onAction, onBack } = {}) {
    this.onAction = onAction || (() => {});
    this.onBack = onBack || (() => {});
    this.screensRoot = document.getElementById('screens');
    this.toastRoot = document.getElementById('toasts');
    this.liveEl = document.getElementById('sr-state');
    this.alertEl = document.getElementById('sr-alerts');
    this.captionEl = document.getElementById('captions');
    this.stack = [];
    this.builders = {};
    this._restoreFocus = new Map();
    this._captionTimer = null;

    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const action = el.dataset.action;
      const params = { ...el.dataset };
      delete params.action;
      this.onAction(action, params, el);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.stack.length > 0) {
        e.preventDefault();
        this.onBack();
      }
      if (e.key === 'Tab') this._trapTab(e);
    });
  }

  register(name, builder) {
    this.builders[name] = builder;
  }

  show(name, params = {}) {
    if (this.stack.includes(name)) this.close(name);
    const build = this.builders[name];
    if (!build) return null;
    const previous = document.activeElement;
    const el = document.createElement('section');
    el.className = 'screen';
    el.dataset.screen = name;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', params.title || name);
    el.innerHTML = build(params);
    this.screensRoot.appendChild(el);
    this.stack.push(name);
    this._restoreFocus.set(name, previous);
    document.body.classList.add('has-screen');
    queueMicrotask(() => {
      const target = el.querySelector('[data-autofocus]') || el.querySelector('button, [href], input, select, [tabindex]');
      target?.focus();
    });
    return el;
  }

  close(name) {
    const idx = name ? this.stack.indexOf(name) : this.stack.length - 1;
    if (idx < 0) return;
    const screenName = this.stack.splice(idx, 1)[0];
    const el = this.screensRoot.querySelector(`[data-screen="${screenName}"]`);
    el?.remove();
    const restore = this._restoreFocus.get(screenName);
    this._restoreFocus.delete(screenName);
    if (this.stack.length === 0) document.body.classList.remove('has-screen');
    if (restore && document.contains(restore)) restore.focus();
  }

  closeAll() {
    while (this.stack.length) this.close();
  }

  isOpen(name) {
    return this.stack.includes(name);
  }

  top() {
    return this.stack[this.stack.length - 1] || null;
  }

  _trapTab(e) {
    const topName = this.top();
    if (!topName) return;
    const el = this.screensRoot.querySelector(`[data-screen="${topName}"]`);
    if (!el) return;
    const focusables = [...el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
      (n) => !n.disabled && n.offsetParent !== null
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  toast(text, { kind = 'info', ms = 2600 } = {}) {
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.setAttribute('role', 'status');
    el.textContent = text;
    this.toastRoot.appendChild(el);
    setTimeout(() => el.classList.add('show'), 16);
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, ms);
    if (kind === 'error') this.announce(text, true);
  }

  announce(text, assertive = false) {
    const el = assertive ? this.alertEl : this.liveEl;
    el.textContent = '';
    // Toggle so repeated identical announcements are re-read.
    requestAnimationFrame(() => {
      el.textContent = text;
    });
  }

  caption(text) {
    if (!this.captionEl) return;
    this.captionEl.textContent = text;
    this.captionEl.classList.add('show');
    clearTimeout(this._captionTimer);
    this._captionTimer = setTimeout(() => this.captionEl.classList.remove('show'), 1800);
  }
}

export function fmtTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtInt(n) {
  return Number(n).toLocaleString('en-US');
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
