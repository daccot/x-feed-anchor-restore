(() => {
  'use strict';

  const PREFIX = '[X Feed Anchor Restore]';
  const KEYS = {
    SETTINGS: 'xfar_settings',
    POSITIONS: 'xfar_positions',
    HISTORY: 'xfar_history',
    LOGS: 'xfar_logs',
    COMMAND: 'xfar_command'
  };

  const DEFAULT_SETTINGS = {
    autoRestore: true,
    showButton: true,
    enableHome: true,
    enableSearch: true,
    enableLists: true,
    enableOtherTimelines: true,
    historyLimit: 20,
    debug: true,
    language: 'auto'
  };

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    routeKey: '',
    url: location.href,
    saveTimer: null,
    routeTimer: null,
    restoring: false,
    lastScrollY: window.scrollY,
    lastUserInputAt: 0,
    ui: { root: null, button: null, status: null, debug: null },
    mo: null
  };

  const now = () => Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const get = (keys) => new Promise((r) => chrome.storage.local.get(keys, r));
  const set = (obj) => new Promise((r) => chrome.storage.local.set(obj, r));

  async function addLog(level, event, detail = {}) {
    const entry = {
      time: new Date().toISOString(),
      level,
      event,
      routeKey: state.routeKey || getRouteKey(),
      url: location.href,
      scrollY: Math.round(window.scrollY),
      detail
    };
    if (state.settings.debug) console.log(PREFIX, entry);
    const data = await get([KEYS.LOGS]);
    const logs = Array.isArray(data[KEYS.LOGS]) ? data[KEYS.LOGS] : [];
    logs.unshift(entry);
    await set({ [KEYS.LOGS]: logs.slice(0, 300) });
    updateDebug(entry);
  }

  function lang() {
    if (state.settings.language === 'ja' || state.settings.language === 'en') return state.settings.language;
    return (navigator.language || '').toLowerCase().startsWith('ja') ? 'ja' : 'en';
  }

  function text(key) {
    const ja = {
      restore: '前の位置へ',
      save: '現在位置を保存',
      saved: '保存しました',
      restored: '復元しました',
      notFound: 'アンカー未検出。スクロール位置で復元しました',
      noSaved: '保存位置なし'
    };
    const en = {
      restore: 'Back to saved post',
      save: 'Save position now',
      saved: 'Saved',
      restored: 'Restored',
      notFound: 'Anchor not found. Restored by scroll position.',
      noSaved: 'No saved position'
    };
    return (lang() === 'ja' ? ja : en)[key] || key;
  }

  function getRouteKey(urlString = location.href) {
    const u = new URL(urlString);
    const p = u.pathname;
    if (p === '/' || p === '/home') return '/home';
    if (p === '/search') {
      return '/search?q=' + encodeURIComponent(u.searchParams.get('q') || '') + '&f=' + encodeURIComponent(u.searchParams.get('f') || '');
    }
    const list = p.match(/^\/i\/lists\/([^/]+)/);
    if (list) return '/i/lists/' + list[1];
    const status = p.match(/^\/([^/]+)\/status\/(\d+)/);
    if (status) return '/status/' + status[2];
    return p;
  }

  function supported(routeKey = getRouteKey()) {
    if (routeKey === '/home') return state.settings.enableHome;
    if (routeKey.startsWith('/search')) return state.settings.enableSearch;
    if (routeKey.startsWith('/i/lists/')) return state.settings.enableLists;
    if (routeKey.startsWith('/status/')) return false;
    return state.settings.enableOtherTimelines;
  }

  function articles() {
    const direct = [...document.querySelectorAll('article[data-testid="tweet"]')];
    if (direct.length) return direct;
    return [...document.querySelectorAll('div[data-testid="cellInnerDiv"] article')];
  }

  function statusInfo(article) {
    const links = [...article.querySelectorAll('a[href*="/status/"]')];
    for (const a of links) {
      const href = a.href || a.getAttribute('href') || '';
      const m = href.match(/\/status\/(\d+)/);
      if (m) return { tweetId: m[1], href };
    }
    return null;
  }

  function headerHeight() {
    let h = 0;
    for (const el of document.querySelectorAll('[role="banner"], header')) {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if ((s.position === 'fixed' || s.position === 'sticky') && r.top <= 5 && r.height < 180) h = Math.max(h, r.height);
    }
    return Math.round(h);
  }

  function snippet(article) {
    const t = article.querySelector('[data-testid="tweetText"]');
    return ((t && t.innerText) || article.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  }

  function author(article) {
    const u = article.querySelector('[data-testid="User-Name"]');
    return ((u && u.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  }

  function visibleAnchor() {
    if (!supported()) return null;
    const hs = headerHeight();
    const vh = window.innerHeight || 800;
    let best = null;
    let bestDist = Infinity;
    const list = articles();
    for (const a of list) {
      const r = a.getBoundingClientRect();
      if (r.bottom <= hs || r.top >= vh) continue;
      const info = statusInfo(a);
      if (!info) continue;
      const d = Math.abs(r.top - hs);
      if (d < bestDist) {
        bestDist = d;
        best = {
          tweetId: info.tweetId,
          href: info.href,
          routeKey: getRouteKey(),
          offsetTopFromViewport: Math.round(r.top - hs),
          scrollY: Math.round(window.scrollY),
          savedAt: now(),
          author: author(a),
          snippet: snippet(a),
          articleCount: list.length,
          headerHeight: hs
        };
      }
    }
    return best;
  }

  async function savePosition(reason = 'auto') {
    const a = visibleAnchor();
    const routeKey = getRouteKey();
    if (!a) {
      await addLog('warn', 'save:no-anchor', { reason, routeKey, articleCount: articles().length });
      return false;
    }
    const data = await get([KEYS.POSITIONS, KEYS.HISTORY]);
    const positions = data[KEYS.POSITIONS] || {};
    const history = Array.isArray(data[KEYS.HISTORY]) ? data[KEYS.HISTORY] : [];
    positions[routeKey] = a;
    const nextHistory = [a, ...history.filter((x) => !(x.routeKey === a.routeKey && x.tweetId === a.tweetId))].slice(0, state.settings.historyLimit || 20);
    await set({ [KEYS.POSITIONS]: positions, [KEYS.HISTORY]: nextHistory });
    setStatus(text('saved') + ': ' + a.routeKey);
    await addLog('info', 'save:ok', { reason, anchor: a });
    return true;
  }

  function findArticle(tweetId) {
    const id = String(tweetId || '').replace(/\D/g, '');
    if (!id) return null;
    const link = document.querySelector(`a[href*="/status/${id}"]`);
    if (!link) return null;
    return link.closest('article') || link.closest('div[data-testid="cellInnerDiv"]');
  }

  async function restorePosition(reason = 'auto') {
    if (!state.settings.autoRestore && reason === 'auto') return false;
    const routeKey = getRouteKey();
    if (!supported(routeKey)) {
      await addLog('info', 'restore:skip-unsupported-route', { reason, routeKey });
      return false;
    }
    const data = await get([KEYS.POSITIONS]);
    const saved = (data[KEYS.POSITIONS] || {})[routeKey];
    if (!saved) {
      await addLog('warn', 'restore:no-saved-position', { reason, routeKey });
      setStatus(text('noSaved'));
      return false;
    }

    state.restoring = true;
    await addLog('info', 'restore:start', { reason, saved });

    // First fallback: raw scrollY. This is imperfect but useful when the anchor is not loaded yet after reload.
    if (typeof saved.scrollY === 'number' && saved.scrollY > 0) {
      window.scrollTo(0, saved.scrollY);
      await addLog('info', 'restore:fallback-scrollY', { scrollY: saved.scrollY });
    }

    const started = now();
    let found = false;
    let attempts = 0;

    while (now() - started < 12000) {
      attempts++;
      const target = findArticle(saved.tweetId);
      if (target) {
        const hs = headerHeight();
        target.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' });
        await sleep(60);
        const r = target.getBoundingClientRect();
        const desired = Number(saved.offsetTopFromViewport) || 0;
        const delta = Math.round((r.top - hs) - desired);
        if (Math.abs(delta) > 2) window.scrollBy(0, delta);
        found = true;
        setStatus(text('restored') + ': ' + saved.tweetId);
        await addLog('info', 'restore:anchor-ok', { attempts, tweetId: saved.tweetId, delta });
        break;
      }
      if (attempts === 8 && typeof saved.scrollY === 'number') window.scrollTo(0, saved.scrollY);
      await sleep(300);
    }

    if (!found) {
      setStatus(text('notFound'));
      await addLog('warn', 'restore:anchor-not-found', { attempts, tweetId: saved.tweetId, scrollY: saved.scrollY, articleCount: articles().length });
    }

    setTimeout(() => { state.restoring = false; }, 800);
    return found;
  }

  function scheduleSave(reason) {
    if (state.restoring) return;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => savePosition(reason), 700);
  }

  function setStatus(msg) {
    ensureUI();
    if (state.ui.status) state.ui.status.textContent = msg;
  }

  function updateDebug(entry) {
    ensureUI();
    if (!state.ui.debug) return;
    state.ui.debug.textContent = entry ? `${entry.level} ${entry.event}\n${entry.routeKey}\nY=${entry.scrollY}` : '';
  }

  function ensureUI() {
    if (!state.settings.showButton) return;
    if (state.ui.root && document.contains(state.ui.root)) return;

    const root = document.createElement('div');
    root.id = 'xfar-root';
    root.style.cssText = 'position:fixed;right:16px;bottom:18px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:12px;color:#0f1419;display:flex;flex-direction:column;gap:6px;align-items:flex-end;';

    const status = document.createElement('div');
    status.style.cssText = 'max-width:280px;background:rgba(15,20,25,.92);color:#fff;padding:6px 9px;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.2);display:none;white-space:pre-wrap;';

    const debug = document.createElement('pre');
    debug.style.cssText = 'max-width:280px;background:rgba(255,255,255,.94);border:1px solid rgba(83,100,113,.35);padding:6px 8px;border-radius:10px;margin:0;display:none;white-space:pre-wrap;';

    const box = document.createElement('div');
    box.style.cssText = 'display:flex;gap:6px;';

    const saveBtn = document.createElement('button');
    saveBtn.textContent = text('save');
    saveBtn.style.cssText = btnStyle();
    saveBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); savePosition('manual-button'); };

    const restoreBtn = document.createElement('button');
    restoreBtn.textContent = text('restore');
    restoreBtn.style.cssText = btnStyle();
    restoreBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); restorePosition('manual-button'); };

    box.appendChild(saveBtn);
    box.appendChild(restoreBtn);
    root.appendChild(status);
    root.appendChild(debug);
    root.appendChild(box);
    document.documentElement.appendChild(root);

    state.ui.root = root;
    state.ui.status = status;
    state.ui.debug = debug;
    state.ui.button = restoreBtn;

    state.ui.status.style.display = 'block';
    if (state.settings.debug) state.ui.debug.style.display = 'block';
  }

  function btnStyle() {
    return 'border:1px solid rgba(83,100,113,.35);border-radius:999px;background:rgba(255,255,255,.96);color:#0f1419;padding:7px 10px;font-weight:700;box-shadow:0 4px 16px rgba(0,0,0,.18);cursor:pointer;';
  }

  function patchHistory() {
    if (window.__xfarPatched) return;
    window.__xfarPatched = true;
    const ps = history.pushState;
    const rs = history.replaceState;
    history.pushState = function(...args) {
      savePosition('before-pushState');
      const ret = ps.apply(this, args);
      setTimeout(() => routeChanged('pushState'), 50);
      return ret;
    };
    history.replaceState = function(...args) {
      const ret = rs.apply(this, args);
      setTimeout(() => routeChanged('replaceState'), 50);
      return ret;
    };
    window.addEventListener('popstate', () => {
      setTimeout(() => routeChanged('popstate'), 80);
    });
  }

  function routeChanged(reason) {
    if (state.url === location.href) return;
    const old = state.url;
    state.url = location.href;
    state.routeKey = getRouteKey();
    addLog('info', 'route:changed', { reason, old, next: state.url, routeKey: state.routeKey });
    clearTimeout(state.routeTimer);
    state.routeTimer = setTimeout(() => restorePosition('route-' + reason), 900);
  }

  function observeRoute() {
    if (state.mo) state.mo.disconnect();
    state.mo = new MutationObserver(() => {
      if (state.url !== location.href) routeChanged('mutation');
      ensureUI();
    });
    state.mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  function listenCommands() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[KEYS.SETTINGS]) {
        state.settings = { ...DEFAULT_SETTINGS, ...(changes[KEYS.SETTINGS].newValue || {}) };
        addLog('info', 'settings:changed', state.settings);
        if (state.ui.debug) state.ui.debug.style.display = state.settings.debug ? 'block' : 'none';
      }
      if (changes[KEYS.COMMAND] && changes[KEYS.COMMAND].newValue) {
        const cmd = changes[KEYS.COMMAND].newValue;
        if (cmd.action === 'save') savePosition('popup-command');
        if (cmd.action === 'restore') restorePosition('popup-command');
      }
    });
  }

  async function loadSettings() {
    const data = await get([KEYS.SETTINGS]);
    state.settings = { ...DEFAULT_SETTINGS, ...(data[KEYS.SETTINGS] || {}) };
  }

  async function init() {
    await loadSettings();
    state.routeKey = getRouteKey();
    patchHistory();
    observeRoute();
    listenCommands();
    ensureUI();

    window.addEventListener('scroll', () => {
      state.lastScrollY = window.scrollY;
      scheduleSave('scroll');
    }, { passive: true });

    window.addEventListener('wheel', () => { state.lastUserInputAt = now(); }, { passive: true, capture: true });
    window.addEventListener('touchstart', () => { state.lastUserInputAt = now(); }, { passive: true, capture: true });
    window.addEventListener('keydown', () => { state.lastUserInputAt = now(); }, true);

    document.addEventListener('click', (e) => {
      state.lastUserInputAt = now();
      const target = e.target instanceof Element ? e.target : null;
      const link = target ? target.closest('a[href*="/status/"]') : null;
      if (link && supported()) savePosition('before-status-click');
    }, true);

    await addLog('info', 'init', { routeKey: state.routeKey, articleCount: articles().length, settings: state.settings });
    setTimeout(() => savePosition('initial-scan'), 1200);
    setTimeout(() => restorePosition('initial-load'), 1800);
  }

  init().catch((e) => {
    console.error(PREFIX, e);
  });
})();
