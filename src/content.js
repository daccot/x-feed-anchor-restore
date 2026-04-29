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

  const RESTORE = {
    timeoutMs: 12000,
    pollMs: 300,
    finalAdjustDelayMs: 280,
    statusMinVisibleMs: 1500,
    cancelGraceMs: 250
  };

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    routeKey: '',
    url: location.href,
    saveTimer: null,
    routeTimer: null,
    statusTimer: null,
    restoring: false,
    restoreSessionId: 0,
    restoreStartedAt: 0,
    restoreCancelled: false,
    lastScrollY: window.scrollY,
    lastUserInputAt: 0,
    ui: { root: null, saveButton: null, restoreButton: null, status: null, debug: null },
    mo: null
  };

  const now = () => Date.now();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const get = (keys) => new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  const set = (obj) => new Promise((resolve) => chrome.storage.local.set(obj, resolve));

  function rectToObject(rect) {
    if (!rect) return null;
    return {
      top: Math.round(rect.top),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

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
      restoredByScroll: 'スクロール位置で復元しました',
      notFound: 'アンカー未検出。スクロール位置で復元しました',
      noSaved: '保存位置なし',
      cancelled: 'ユーザー操作により復元を中断しました'
    };
    const en = {
      restore: 'Back to saved post',
      save: 'Save position now',
      saved: 'Saved',
      restored: 'Restored',
      restoredByScroll: 'Restored by scroll position',
      notFound: 'Anchor not found. Restored by scroll position.',
      noSaved: 'No saved position',
      cancelled: 'Restore cancelled by user action'
    };
    return (lang() === 'ja' ? ja : en)[key] || key;
  }

  function getRouteKey(urlString = location.href) {
    const u = new URL(urlString);
    const p = u.pathname;
    if (p === '/' || p === '/home') return '/home';
    if (p === '/search') return '/search?q=' + encodeURIComponent(u.searchParams.get('q') || '') + '&f=' + encodeURIComponent(u.searchParams.get('f') || '');
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

  function uniqueElements(elements) {
    const seen = new Set();
    const result = [];
    for (const el of elements) {
      if (!el || seen.has(el)) continue;
      seen.add(el);
      result.push(el);
    }
    return result;
  }

  function articles() {
    return uniqueElements([
      ...document.querySelectorAll('article[data-testid="tweet"]'),
      ...document.querySelectorAll('div[data-testid="cellInnerDiv"] article[data-testid="tweet"]'),
      ...document.querySelectorAll('div[data-testid="cellInnerDiv"] article')
    ]);
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

  function tweetText(article) {
    const t = article.querySelector('[data-testid="tweetText"]');
    return ((t && t.innerText) || '').replace(/\s+/g, ' ').trim();
  }

  function snippet(article) {
    const explicit = tweetText(article);
    const fallback = (article.innerText || '').replace(/\s+/g, ' ').trim();
    return (explicit || fallback).slice(0, 140);
  }

  function author(article) {
    const u = article.querySelector('[data-testid="User-Name"]');
    return ((u && u.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  }

  function visibleAnchor() {
    if (!supported()) return null;
    const hs = headerHeight();
    const vh = window.innerHeight || 800;
    const list = articles();
    const visible = [];

    for (const article of list) {
      const rect = article.getBoundingClientRect();
      const info = statusInfo(article);
      if (!info) continue;
      const fullyVisible = rect.top >= hs && rect.bottom <= vh;
      const partiallyVisible = rect.bottom > hs && rect.top < vh;
      if (!partiallyVisible) continue;
      visible.push({ article, rect, info, fullyVisible, textLength: tweetText(article).length, distanceFromTop: Math.abs(rect.top - hs) });
    }

    if (!visible.length) {
      addLog('warn', 'anchor:no-visible-candidates', { articleCount: list.length, headerHeight: hs, viewportHeight: vh });
      return null;
    }

    visible.sort((a, b) => a.rect.top - b.rect.top);
    const fullyVisible = visible.filter((item) => item.fullyVisible);
    let preferred;
    if (fullyVisible.length >= 3) preferred = fullyVisible.slice(1, 3);
    else if (fullyVisible.length >= 2) preferred = fullyVisible.slice(1, 2);
    else if (fullyVisible.length === 1) preferred = fullyVisible;
    else preferred = visible.slice(0, Math.min(3, visible.length));

    preferred.sort((a, b) => {
      if (b.textLength !== a.textLength) return b.textLength - a.textLength;
      return a.distanceFromTop - b.distanceFromTop;
    });

    const best = preferred[0];
    const r = best.rect;
    const anchor = {
      tweetId: best.info.tweetId,
      href: best.info.href,
      routeKey: getRouteKey(),
      offsetTopFromViewport: Math.round(r.top - hs),
      scrollY: Math.round(window.scrollY),
      savedAt: now(),
      author: author(best.article),
      snippet: snippet(best.article),
      articleCount: list.length,
      visibleCount: visible.length,
      fullyVisibleCount: fullyVisible.length,
      headerHeight: hs,
      viewportHeight: vh,
      selectedRect: rectToObject(r),
      selectedTextLength: best.textLength,
      selectionReason: fullyVisible.length >= 2 ? 'prefer-2nd-or-3rd-fully-visible-long-text' : 'fallback-visible-candidate'
    };

    addLog('info', 'anchor:selected', { tweetId: anchor.tweetId, routeKey: anchor.routeKey, selectionReason: anchor.selectionReason, selectedRect: anchor.selectedRect, selectedTextLength: anchor.selectedTextLength, visibleCount: anchor.visibleCount, fullyVisibleCount: anchor.fullyVisibleCount });
    return anchor;
  }

  async function savePosition(reason = 'auto') {
    if (state.restoring && !String(reason).startsWith('manual')) {
      await addLog('info', 'save:suppressed-during-restore', { reason });
      return false;
    }
    const anchor = visibleAnchor();
    const routeKey = getRouteKey();
    if (!anchor) {
      await addLog('warn', 'save:no-anchor', { reason, routeKey, articleCount: articles().length, scrollY: Math.round(window.scrollY) });
      return false;
    }
    const data = await get([KEYS.POSITIONS, KEYS.HISTORY]);
    const positions = data[KEYS.POSITIONS] || {};
    const history = Array.isArray(data[KEYS.HISTORY]) ? data[KEYS.HISTORY] : [];
    positions[routeKey] = anchor;
    const nextHistory = [anchor, ...history.filter((item) => !(item.routeKey === anchor.routeKey && item.tweetId === anchor.tweetId))].slice(0, state.settings.historyLimit || 20);
    await set({ [KEYS.POSITIONS]: positions, [KEYS.HISTORY]: nextHistory });
    setStatus(`${text('saved')}: ${anchor.routeKey}`, RESTORE.statusMinVisibleMs);
    await addLog('info', 'save:ok', { reason, anchor });
    return true;
  }

  function findArticle(tweetId) {
    const id = String(tweetId || '').replace(/\D/g, '');
    if (!id) return null;
    const links = [...document.querySelectorAll(`a[href*="/status/${id}"]`)];
    for (const link of links) {
      const article = link.closest('article') || link.closest('div[data-testid="cellInnerDiv"]');
      if (article) return article;
    }
    return null;
  }

  function markUserInput(source) {
    state.lastUserInputAt = now();
    if (state.restoring && now() - state.restoreStartedAt > RESTORE.cancelGraceMs) {
      state.restoreCancelled = true;
      addLog('warn', 'restore:cancel-requested-by-user', { source });
      setStatus(text('cancelled'), RESTORE.statusMinVisibleMs);
    }
  }

  function restoreCancelled(sessionId) {
    return state.restoreCancelled || sessionId !== state.restoreSessionId;
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
      setStatus(text('noSaved'), RESTORE.statusMinVisibleMs);
      return false;
    }

    const sessionId = ++state.restoreSessionId;
    state.restoring = true;
    state.restoreCancelled = false;
    state.restoreStartedAt = now();
    await addLog('info', 'restore:start', { reason, sessionId, saved });

    let didScrollFallback = false;
    let found = false;
    let attempts = 0;

    try {
      if (typeof saved.scrollY === 'number' && saved.scrollY > 0) {
        window.scrollTo(0, saved.scrollY);
        didScrollFallback = true;
        await addLog('info', 'restore:fallback-scrollY', { sessionId, scrollY: saved.scrollY });
        await sleep(120);
      }
      const started = now();
      while (now() - started < RESTORE.timeoutMs) {
        if (restoreCancelled(sessionId)) {
          await addLog('warn', 'restore:cancelled', { sessionId, attempts, scrollY: Math.round(window.scrollY) });
          return false;
        }
        attempts++;
        const target = findArticle(saved.tweetId);
        if (target) {
          const beforeRect = target.getBoundingClientRect();
          await addLog('info', 'restore:anchor-found', { sessionId, attempts, tweetId: saved.tweetId, beforeRect: rectToObject(beforeRect), savedOffsetTopFromViewport: saved.offsetTopFromViewport, savedScrollY: saved.scrollY });
          target.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' });
          await sleep(RESTORE.finalAdjustDelayMs);
          if (restoreCancelled(sessionId)) {
            await addLog('warn', 'restore:cancelled-before-final-adjust', { sessionId, attempts });
            return false;
          }
          const hs = headerHeight();
          const afterRect = target.getBoundingClientRect();
          const desired = Number(saved.offsetTopFromViewport) || 0;
          const delta = Math.round((afterRect.top - hs) - desired);
          if (Math.abs(delta) > 2) window.scrollBy(0, delta);
          await sleep(80);
          const finalRect = target.getBoundingClientRect();
          found = true;
          setStatus(`${text('restored')}: ${saved.tweetId}`, RESTORE.statusMinVisibleMs);
          await addLog('info', 'restore:anchor-ok', { sessionId, attempts, tweetId: saved.tweetId, headerHeight: hs, desiredOffset: desired, delta, afterRect: rectToObject(afterRect), finalRect: rectToObject(finalRect), finalScrollY: Math.round(window.scrollY) });
          break;
        }
        if (attempts === 5 && typeof saved.scrollY === 'number' && saved.scrollY > 0) {
          window.scrollTo(0, saved.scrollY);
          didScrollFallback = true;
          await addLog('info', 'restore:retry-fallback-scrollY', { sessionId, attempts, scrollY: saved.scrollY });
        }
        await sleep(RESTORE.pollMs);
      }
      if (!found) {
        setStatus(didScrollFallback ? text('restoredByScroll') : text('notFound'), RESTORE.statusMinVisibleMs);
        await addLog('warn', 'restore:anchor-not-found', { sessionId, attempts, tweetId: saved.tweetId, didScrollFallback, savedScrollY: saved.scrollY, currentScrollY: Math.round(window.scrollY), articleCount: articles().length });
      }
      return found;
    } finally {
      setTimeout(() => {
        if (sessionId === state.restoreSessionId) {
          state.restoring = false;
          state.restoreCancelled = false;
        }
      }, 900);
    }
  }

  function scheduleSave(reason) {
    if (state.restoring) return;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => savePosition(reason), 700);
  }

  function setStatus(message, minVisibleMs = RESTORE.statusMinVisibleMs) {
    ensureUI();
    if (!state.ui.status) return;
    state.ui.status.textContent = message;
    state.ui.status.style.display = 'block';
    clearTimeout(state.statusTimer);
    state.statusTimer = setTimeout(() => {
      if (state.ui.status) state.ui.status.style.display = 'none';
    }, Math.max(1500, minVisibleMs));
  }

  function updateDebug(entry) {
    ensureUI();
    if (!state.ui.debug) return;
    if (!state.settings.debug) {
      state.ui.debug.style.display = 'none';
      return;
    }
    state.ui.debug.style.display = 'block';
    state.ui.debug.textContent = entry ? [`${entry.level} ${entry.event}`, `route=${entry.routeKey}`, `Y=${entry.scrollY}`, `time=${entry.time}`].join('\n') : '';
  }

  function ensureUI() {
    if (!state.settings.showButton) return;
    if (state.ui.root && document.contains(state.ui.root)) return;
    const root = document.createElement('div');
    root.id = 'xfar-root';
    root.style.cssText = 'position:fixed;right:16px;bottom:18px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:12px;color:#0f1419;display:flex;flex-direction:column;gap:6px;align-items:flex-end;';
    const status = document.createElement('div');
    status.style.cssText = 'max-width:300px;background:rgba(15,20,25,.92);color:#fff;padding:7px 10px;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.2);display:none;white-space:pre-wrap;';
    const debug = document.createElement('pre');
    debug.style.cssText = 'max-width:300px;background:rgba(255,255,255,.94);border:1px solid rgba(83,100,113,.35);padding:6px 8px;border-radius:10px;margin:0;display:none;white-space:pre-wrap;';
    const box = document.createElement('div');
    box.style.cssText = 'display:flex;gap:6px;';
    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.textContent = text('save');
    saveButton.style.cssText = buttonStyle();
    saveButton.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); savePosition('manual-button'); });
    const restoreButton = document.createElement('button');
    restoreButton.type = 'button';
    restoreButton.textContent = text('restore');
    restoreButton.style.cssText = buttonStyle();
    restoreButton.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); restorePosition('manual-button'); });
    box.appendChild(saveButton);
    box.appendChild(restoreButton);
    root.appendChild(status);
    root.appendChild(debug);
    root.appendChild(box);
    document.documentElement.appendChild(root);
    state.ui.root = root;
    state.ui.saveButton = saveButton;
    state.ui.restoreButton = restoreButton;
    state.ui.status = status;
    state.ui.debug = debug;
    if (state.settings.debug) state.ui.debug.style.display = 'block';
  }

  function buttonStyle() {
    return 'border:1px solid rgba(83,100,113,.35);border-radius:999px;background:rgba(255,255,255,.96);color:#0f1419;padding:7px 10px;font-weight:700;box-shadow:0 4px 16px rgba(0,0,0,.18);cursor:pointer;';
  }

  function patchHistory() {
    if (window.__xfarPatched) return;
    window.__xfarPatched = true;
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function patchedPushState(...args) {
      savePosition('before-pushState');
      const result = originalPushState.apply(this, args);
      setTimeout(() => routeChanged('pushState'), 50);
      return result;
    };
    history.replaceState = function patchedReplaceState(...args) {
      const result = originalReplaceState.apply(this, args);
      setTimeout(() => routeChanged('replaceState'), 50);
      return result;
    };
    window.addEventListener('popstate', () => setTimeout(() => routeChanged('popstate'), 80));
  }

  function routeChanged(reason) {
    if (state.url === location.href) return;
    const old = state.url;
    state.url = location.href;
    state.routeKey = getRouteKey();
    addLog('info', 'route:changed', { reason, old, next: state.url, routeKey: state.routeKey });
    clearTimeout(state.routeTimer);
    state.routeTimer = setTimeout(() => restorePosition(`route-${reason}`), 900);
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
        const command = changes[KEYS.COMMAND].newValue;
        if (command.action === 'save') savePosition('popup-command');
        if (command.action === 'restore') restorePosition('popup-command');
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
      if (state.restoring) {
        if (now() - state.restoreStartedAt > RESTORE.cancelGraceMs) addLog('info', 'scroll:during-restore-save-suppressed', { scrollY: Math.round(window.scrollY) });
        return;
      }
      scheduleSave('scroll');
    }, { passive: true });
    window.addEventListener('wheel', () => markUserInput('wheel'), { passive: true, capture: true });
    window.addEventListener('touchstart', () => markUserInput('touchstart'), { passive: true, capture: true });
    window.addEventListener('keydown', () => markUserInput('keydown'), true);
    document.addEventListener('click', (event) => {
      state.lastUserInputAt = now();
      const target = event.target instanceof Element ? event.target : null;
      const link = target ? target.closest('a[href*="/status/"]') : null;
      if (link && supported()) savePosition('before-status-click');
    }, true);
    await addLog('info', 'init', { routeKey: state.routeKey, articleCount: articles().length, settings: state.settings });
    setTimeout(() => savePosition('initial-scan'), 1200);
    setTimeout(() => restorePosition('initial-load'), 1800);
  }

  init().catch((error) => console.error(PREFIX, error));
})();
