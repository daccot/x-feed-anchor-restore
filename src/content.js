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
    showButton: false,
    enableHome: true,
    enableSearch: true,
    enableLists: true,
    enableOtherTimelines: true,
    historyLimit: 20,
    debug: true,
    language: 'auto'
  };

  const RESTORE = {
    timeoutMs: 14000,
    pollMs: 300,
    finalAdjustDelayMs: 400,
    statusMinVisibleMs: 1500,
    loadingStatusMs: 4500,
    cancelGraceMs: 250,
    virtualLoadScrollStep: 1000,
    virtualLoadMaxSteps: 4,
    nearbyRangePx: 300,
    nearbyLimit: 16,
    initialMinArticles: 10,
    initialReadyTimeoutMs: 12000,
    initialRetryMax: 2,
    initialRetryBaseDelayMs: 900,
    driftCheckDelayMs: 900,
    driftThresholdPx: 180,
    driftMaxCorrections: 2
  };

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    routeKey: '',
    url: location.href,
    saveTimer: null,
    routeTimer: null,
    statusTimer: null,
    driftTimer: null,
    restoring: false,
    restoreSessionId: 0,
    restoreStartedAt: 0,
    restoreCancelled: false,
    timelineReadyStarted: false,
    lastRestoreTarget: null,
    lastRestoreSaved: null,
    driftCorrectionCount: 0,
    lastScrollY: window.scrollY,
    lastUserInputAt: 0,
    ui: { root: null, saveButton: null, restoreButton: null, historyButton: null, status: null, debug: null, historyPanel: null },
    mo: null
  };

  try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch (_) {}

  const now = () => Date.now();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const get = (keys) => new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  const set = (obj) => new Promise((resolve) => chrome.storage.local.set(obj, resolve));

  function rectToObject(rect) {
    if (!rect) return null;
    return { top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) };
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>\"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }

  async function addLog(level, event, detail = {}) {
    const entry = { time: new Date().toISOString(), level, event, routeKey: state.routeKey || getRouteKey(), url: location.href, scrollY: Math.round(window.scrollY), detail };
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
    const ja = { restore: '前の位置へ', save: '現在位置を保存', history: '履歴', saved: '保存しました', restored: '復元しました', restoredByScroll: 'スクロール位置で復元しました', loading: '復元中...', waitingTimeline: 'タイムライン読み込み待機中...', notFound: 'アンカー未検出。スクロール位置で復元しました', noSaved: '保存位置なし', cancelled: 'ユーザー操作により復元を中断しました', historyTitle: '復元履歴', noHistory: '履歴なし', corrected: 'ズレを補正しました' };
    const en = { restore: 'Back', save: 'Save', history: 'History', saved: 'Saved', restored: 'Restored', restoredByScroll: 'Restored by scroll position', loading: 'Loading...', waitingTimeline: 'Waiting for timeline...', notFound: 'Anchor not found. Restored by scroll position.', noSaved: 'No saved position', cancelled: 'Restore cancelled by user action', historyTitle: 'Restore history', noHistory: 'No history', corrected: 'Drift corrected' };
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
      ...document.querySelectorAll('div[data-testid="cellInnerDiv"] article'),
      ...document.querySelectorAll('div[data-testid="cellInnerDiv"] [data-testid="tweet"]')
    ]).map((el) => el.closest('article') || el).filter(Boolean);
  }

  function statusInfo(root) {
    const links = [...root.querySelectorAll('a[href*="/status/"]')];
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
    const currentY = Math.round(window.scrollY);
    const list = articles();
    const visible = [];
    const nearby = [];

    for (const article of list) {
      const rect = article.getBoundingClientRect();
      const info = statusInfo(article);
      if (!info) continue;
      const absTop = Math.round(currentY + rect.top);
      const fullyVisible = rect.top >= hs && rect.bottom <= vh;
      const partiallyVisible = rect.bottom > hs && rect.top < vh;
      const item = { article, rect, info, fullyVisible, partiallyVisible, textLength: tweetText(article).length, distanceFromTop: Math.abs(rect.top - hs), absTop };
      if (partiallyVisible) visible.push(item);
      if (Math.abs(absTop - currentY) <= RESTORE.nearbyRangePx) nearby.push({ tweetId: info.tweetId, href: info.href, absTop, rect: rectToObject(rect), textLength: item.textLength, snippet: snippet(article) });
    }

    if (!visible.length) {
      addLog('warn', 'anchor:no-visible-candidates', { articleCount: list.length, headerHeight: hs, viewportHeight: vh, scrollY: currentY });
      return null;
    }

    visible.sort((a, b) => a.rect.top - b.rect.top);
    nearby.sort((a, b) => b.textLength - a.textLength);
    const fullyVisible = visible.filter((item) => item.fullyVisible);
    let preferred;
    if (fullyVisible.length >= 3) preferred = fullyVisible.slice(1, 3);
    else if (fullyVisible.length >= 2) preferred = fullyVisible.slice(1, 2);
    else if (fullyVisible.length === 1) preferred = fullyVisible;
    else preferred = visible.slice(0, Math.min(3, visible.length));

    preferred.sort((a, b) => b.textLength !== a.textLength ? b.textLength - a.textLength : a.distanceFromTop - b.distanceFromTop);
    const best = preferred[0];
    const r = best.rect;
    const anchor = { tweetId: best.info.tweetId, href: best.info.href, routeKey: getRouteKey(), offsetTopFromViewport: Math.round(r.top - hs), scrollY: Math.round(window.scrollY), savedAt: now(), author: author(best.article), snippet: snippet(best.article), articleCount: list.length, visibleCount: visible.length, fullyVisibleCount: fullyVisible.length, headerHeight: hs, viewportHeight: vh, selectedRect: rectToObject(r), selectedTextLength: best.textLength, selectionReason: fullyVisible.length >= 2 ? 'prefer-2nd-or-3rd-fully-visible-long-text' : 'fallback-visible-candidate', nearbyAnchors: nearby.slice(0, RESTORE.nearbyLimit) };
    addLog('info', 'anchor:selected', { tweetId: anchor.tweetId, routeKey: anchor.routeKey, selectionReason: anchor.selectionReason, selectedRect: anchor.selectedRect, nearbyCount: anchor.nearbyAnchors.length, visibleCount: anchor.visibleCount, fullyVisibleCount: anchor.fullyVisibleCount });
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
    const selectors = [`a[href*="/status/${id}"]`, `div[data-testid="cellInnerDiv"] a[href*="/status/${id}"]`, `article a[href*="/status/${id}"]`];
    for (const selector of selectors) {
      const links = [...document.querySelectorAll(selector)];
      for (const link of links) {
        const article = link.closest('article') || link.closest('div[data-testid="cellInnerDiv"]') || link.closest('[data-testid="tweet"]');
        if (article) return article;
      }
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

  async function waitForTimelineReady(reason) {
    const started = now();
    await addLog('info', 'timeline-ready:wait-start', { reason, minArticles: RESTORE.initialMinArticles });
    return new Promise((resolve) => {
      let done = false;
      let interval = null;
      let observer = null;
      const finish = (ok, why) => {
        if (done) return;
        done = true;
        if (interval) clearInterval(interval);
        if (observer) observer.disconnect();
        addLog(ok ? 'info' : 'warn', 'timeline-ready:finish', { ok, why, elapsedMs: now() - started, articleCount: articles().length });
        resolve(ok);
      };
      const check = () => {
        const count = articles().length;
        if (count >= RESTORE.initialMinArticles) finish(true, 'article-count');
        else if (now() - started >= RESTORE.initialReadyTimeoutMs) finish(false, 'timeout');
      };
      observer = new MutationObserver(check);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      interval = setInterval(check, 250);
      check();
    });
  }

  async function adjustToTarget(target, saved, sessionId, label) {
    target.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' });
    await sleep(RESTORE.finalAdjustDelayMs);
    if (restoreCancelled(sessionId)) return { cancelled: true };
    const hs1 = headerHeight();
    const rect1 = target.getBoundingClientRect();
    const desired = Number(saved.offsetTopFromViewport) || 0;
    const delta1 = Math.round((rect1.top - hs1) - desired);
    if (Math.abs(delta1) > 2) window.scrollBy(0, delta1);
    await sleep(160);
    const hs2 = headerHeight();
    const rect2 = target.getBoundingClientRect();
    const delta2 = Math.round((rect2.top - hs2) - desired);
    if (Math.abs(delta2) > 2) window.scrollBy(0, delta2);
    await sleep(80);
    const rect3 = target.getBoundingClientRect();
    await addLog('info', 'restore:adjusted', { sessionId, label, desiredOffset: desired, header1: hs1, header2: hs2, delta1, delta2, rect1: rectToObject(rect1), rect2: rectToObject(rect2), rect3: rectToObject(rect3), finalScrollY: Math.round(window.scrollY) });
    return { cancelled: false, delta1, delta2, finalRect: rectToObject(rect3) };
  }

  function scheduleDriftCheck(target, saved, sessionId) {
    clearTimeout(state.driftTimer);
    if (!target || !saved) return;
    state.lastRestoreTarget = target;
    state.lastRestoreSaved = saved;
    state.driftTimer = setTimeout(async () => {
      if (state.restoring || restoreCancelled(sessionId)) return;
      if (now() - state.lastUserInputAt < 1200) return;
      if (!document.contains(target)) return;
      const hs = headerHeight();
      const rect = target.getBoundingClientRect();
      const desired = Number(saved.offsetTopFromViewport) || 0;
      const drift = Math.round((rect.top - hs) - desired);
      if (Math.abs(drift) >= RESTORE.driftThresholdPx && state.driftCorrectionCount < RESTORE.driftMaxCorrections) {
        state.driftCorrectionCount++;
        window.scrollBy(0, drift);
        setStatus(text('corrected'), RESTORE.statusMinVisibleMs);
        await addLog('info', 'drift:auto-corrected', { sessionId, drift, correctionCount: state.driftCorrectionCount, rect: rectToObject(rect), desiredOffset: desired });
        scheduleDriftCheck(target, saved, sessionId);
      } else {
        await addLog('info', 'drift:checked', { sessionId, drift, correctionCount: state.driftCorrectionCount, rect: rectToObject(rect), desiredOffset: desired });
      }
    }, RESTORE.driftCheckDelayMs);
  }

  async function restoreAnchorObject(saved, reason = 'history') {
    if (!saved) return false;
    if (saved.routeKey && saved.routeKey !== getRouteKey() && !saved.routeKey.startsWith('/status/')) {
      history.pushState({}, '', saved.routeKey);
      state.url = location.href;
      state.routeKey = getRouteKey();
      await sleep(600);
    }
    return restorePosition(reason, { explicitSaved: saved });
  }

  async function restorePosition(reason = 'auto', options = {}) {
    if (!state.settings.autoRestore && reason === 'auto') return false;
    const routeKey = getRouteKey();
    if (!supported(routeKey) && !options.explicitSaved) {
      await addLog('info', 'restore:skip-unsupported-route', { reason, routeKey });
      return false;
    }
    const data = await get([KEYS.POSITIONS]);
    const saved = options.explicitSaved || (data[KEYS.POSITIONS] || {})[routeKey];
    if (!saved) {
      await addLog('warn', 'restore:no-saved-position', { reason, routeKey });
      setStatus(text('noSaved'), RESTORE.statusMinVisibleMs);
      return false;
    }
    const sessionId = ++state.restoreSessionId;
    state.restoring = true;
    state.restoreCancelled = false;
    state.restoreStartedAt = now();
    state.driftCorrectionCount = 0;
    if (!options.silent) setStatus(text('loading'), RESTORE.loadingStatusMs);
    await addLog('info', 'restore:start', { reason, sessionId, saved, scrollRestoration: history.scrollRestoration, articleCount: articles().length, fast: Boolean(options.fast) });
    let didScrollFallback = false;
    let found = false;
    let attempts = 0;
    let virtualLoadSteps = 0;
    try {
      if (typeof saved.scrollY === 'number' && saved.scrollY > 0) {
        window.scrollTo(0, saved.scrollY);
        didScrollFallback = true;
        await addLog('info', 'restore:fallback-scrollY', { sessionId, scrollY: saved.scrollY, fast: Boolean(options.fast) });
        if (options.fast) setStatus(text('restoredByScroll'), RESTORE.statusMinVisibleMs);
        await sleep(options.fast ? 60 : 180);
      }
      const started = now();
      while (now() - started < RESTORE.timeoutMs) {
        if (restoreCancelled(sessionId)) {
          await addLog('warn', 'restore:cancelled', { sessionId, attempts, scrollY: Math.round(window.scrollY) });
          return false;
        }
        attempts++;
        let target = findArticle(saved.tweetId);
        let targetSource = 'primary';
        if (!target && Array.isArray(saved.nearbyAnchors)) {
          for (const near of saved.nearbyAnchors) {
            target = findArticle(near.tweetId);
            if (target) { targetSource = 'nearby:' + near.tweetId; break; }
          }
        }
        if (target) {
          const beforeRect = target.getBoundingClientRect();
          await addLog('info', 'restore:anchor-found', { sessionId, attempts, targetSource, tweetId: saved.tweetId, beforeRect: rectToObject(beforeRect), savedOffsetTopFromViewport: saved.offsetTopFromViewport, savedScrollY: saved.scrollY, currentScrollY: Math.round(window.scrollY) });
          const adjusted = await adjustToTarget(target, saved, sessionId, targetSource);
          if (adjusted.cancelled) return false;
          found = true;
          setStatus(`${text('restored')}: ${saved.tweetId}`, RESTORE.statusMinVisibleMs);
          await addLog('info', 'restore:anchor-ok', { sessionId, attempts, targetSource, tweetId: saved.tweetId, adjusted });
          scheduleDriftCheck(target, saved, sessionId);
          break;
        }
        if (attempts === 5 && typeof saved.scrollY === 'number' && saved.scrollY > 0) {
          window.scrollTo(0, saved.scrollY);
          didScrollFallback = true;
          await addLog('info', 'restore:retry-fallback-scrollY', { sessionId, attempts, scrollY: saved.scrollY });
        }
        if (attempts >= 6 && virtualLoadSteps < RESTORE.virtualLoadMaxSteps) {
          virtualLoadSteps++;
          window.scrollBy(0, RESTORE.virtualLoadScrollStep);
          await addLog('info', 'restore:virtual-load-scroll', { sessionId, attempts, virtualLoadSteps, stepPx: RESTORE.virtualLoadScrollStep, scrollY: Math.round(window.scrollY) });
          await sleep(500);
        } else {
          await sleep(RESTORE.pollMs);
        }
      }
      if (!found) {
        setStatus(didScrollFallback ? text('restoredByScroll') : text('notFound'), RESTORE.statusMinVisibleMs);
        await addLog('warn', 'restore:anchor-not-found', { sessionId, attempts, virtualLoadSteps, tweetId: saved.tweetId, didScrollFallback, savedScrollY: saved.scrollY, currentScrollY: Math.round(window.scrollY), articleCount: articles().length, nearbyCount: Array.isArray(saved.nearbyAnchors) ? saved.nearbyAnchors.length : 0 });
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

  async function fastInitialRestoreThenRefine() {
    if (!supported()) return;
    if (state.timelineReadyStarted) return;
    state.timelineReadyStarted = true;
    await restorePosition('initial-fast', { fast: true, silent: true });
    const ready = await waitForTimelineReady('initial-refine');
    for (let i = 1; i <= RESTORE.initialRetryMax; i++) {
      const delay = i === 1 ? 0 : RESTORE.initialRetryBaseDelayMs * (i - 1);
      if (delay) await sleep(delay);
      await addLog('info', 'initial-refine:attempt', { attempt: i, ready, articleCount: articles().length, delay });
      const ok = await restorePosition('initial-refine', { silent: true });
      if (ok) {
        await addLog('info', 'initial-refine:success', { attempt: i });
        return true;
      }
    }
    await addLog('warn', 'initial-refine:failed-after-retry', { retryMax: RESTORE.initialRetryMax, articleCount: articles().length });
    return false;
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
    state.statusTimer = setTimeout(() => { if (state.ui.status) state.ui.status.style.display = 'none'; }, Math.max(1500, minVisibleMs));
  }

  function updateDebug(entry) {
    ensureUI();
    if (!state.ui.debug) return;
    if (!state.settings.debug) { state.ui.debug.style.display = 'none'; return; }
    state.ui.debug.style.display = 'block';
    state.ui.debug.textContent = entry ? [`${entry.level} ${entry.event}`, `route=${entry.routeKey}`, `Y=${entry.scrollY}`, `time=${entry.time}`].join('\n') : '';
  }

  async function toggleHistoryPanel() {
    ensureUI();
    const panel = state.ui.historyPanel;
    if (!panel) return;
    if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
    const data = await get([KEYS.HISTORY]);
    const history = Array.isArray(data[KEYS.HISTORY]) ? data[KEYS.HISTORY] : [];
    panel.innerHTML = `<div style="font-weight:700;margin-bottom:8px;">${escapeHtml(text('historyTitle'))}</div>`;
    if (!history.length) {
      panel.innerHTML += `<div style="color:#536471;padding:8px 0;">${escapeHtml(text('noHistory'))}</div>`;
    }
    history.slice(0, state.settings.historyLimit || 20).forEach((item) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.style.cssText = 'display:block;width:100%;text-align:left;border:0;border-top:1px solid rgba(83,100,113,.25);background:transparent;color:#0f1419;padding:8px 4px;cursor:pointer;';
      const date = item.savedAt ? new Date(item.savedAt).toLocaleString() : '';
      row.innerHTML = `<strong>${escapeHtml(item.routeKey || '')}</strong><br><small>${escapeHtml(item.author || '')}</small><br><span>${escapeHtml(item.snippet || item.tweetId || '')}</span><br><small>${escapeHtml(date)}</small>`;
      row.addEventListener('click', (event) => {
        event.preventDefault(); event.stopPropagation();
        panel.style.display = 'none';
        restoreAnchorObject(item, 'history-panel');
      });
      panel.appendChild(row);
    });
    panel.style.display = 'block';
  }

  function ensureUI() {
    if (!state.settings.showButton) { removeUI(); return; }
    if (state.ui.root && document.contains(state.ui.root)) return;
    const root = document.createElement('div');
    root.id = 'xfar-root';
    root.style.cssText = 'position:fixed;right:16px;bottom:18px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:12px;color:#0f1419;display:flex;flex-direction:column;gap:6px;align-items:flex-end;';
    const status = document.createElement('div');
    status.style.cssText = 'max-width:300px;background:rgba(15,20,25,.92);color:#fff;padding:7px 10px;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.2);display:none;white-space:pre-wrap;';
    const debug = document.createElement('pre');
    debug.style.cssText = 'max-width:300px;background:rgba(255,255,255,.94);border:1px solid rgba(83,100,113,.35);padding:6px 8px;border-radius:10px;margin:0;display:none;white-space:pre-wrap;';
    const historyPanel = document.createElement('div');
    historyPanel.style.cssText = 'display:none;width:340px;max-height:420px;overflow:auto;background:rgba(255,255,255,.98);border:1px solid rgba(83,100,113,.35);border-radius:14px;box-shadow:0 8px 28px rgba(0,0,0,.24);padding:10px;';
    const box = document.createElement('div');
    box.style.cssText = 'display:flex;gap:6px;';
    const saveButton = document.createElement('button');
    saveButton.type = 'button'; saveButton.textContent = text('save'); saveButton.style.cssText = buttonStyle();
    saveButton.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); savePosition('manual-button'); });
    const restoreButton = document.createElement('button');
    restoreButton.type = 'button'; restoreButton.textContent = text('restore'); restoreButton.style.cssText = buttonStyle();
    restoreButton.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); restorePosition('manual-button'); });
    const historyButton = document.createElement('button');
    historyButton.type = 'button'; historyButton.textContent = text('history'); historyButton.style.cssText = buttonStyle();
    historyButton.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); toggleHistoryPanel(); });
    box.appendChild(saveButton); box.appendChild(restoreButton); box.appendChild(historyButton);
    root.appendChild(status); root.appendChild(debug); root.appendChild(historyPanel); root.appendChild(box);
    document.documentElement.appendChild(root);
    state.ui.root = root; state.ui.saveButton = saveButton; state.ui.restoreButton = restoreButton; state.ui.historyButton = historyButton; state.ui.status = status; state.ui.debug = debug; state.ui.historyPanel = historyPanel;
    if (state.settings.debug) state.ui.debug.style.display = 'block';
  }

  function removeUI() {
    if (state.ui.root && state.ui.root.parentNode) state.ui.root.parentNode.removeChild(state.ui.root);
    state.ui = { root: null, saveButton: null, restoreButton: null, historyButton: null, status: null, debug: null, historyPanel: null };
  }

  function buttonStyle() {
    return 'border:1px solid rgba(83,100,113,.35);border-radius:999px;background:rgba(255,255,255,.96);color:#0f1419;padding:7px 10px;font-weight:700;box-shadow:0 4px 16px rgba(0,0,0,.18);cursor:pointer;';
  }

  function patchHistory() {
    if (window.__xfarPatched) return;
    window.__xfarPatched = true;
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function patchedPushState(...args) { savePosition('before-pushState'); const result = originalPushState.apply(this, args); setTimeout(() => routeChanged('pushState'), 50); return result; };
    history.replaceState = function patchedReplaceState(...args) { const result = originalReplaceState.apply(this, args); setTimeout(() => routeChanged('replaceState'), 50); return result; };
    window.addEventListener('popstate', () => setTimeout(() => routeChanged('popstate'), 80));
  }

  function routeChanged(reason) {
    if (state.url === location.href) return;
    const old = state.url;
    state.url = location.href;
    state.routeKey = getRouteKey();
    state.timelineReadyStarted = false;
    addLog('info', 'route:changed', { reason, old, next: state.url, routeKey: state.routeKey });
    clearTimeout(state.routeTimer);
    state.routeTimer = setTimeout(() => restorePosition(`route-${reason}`), 500);
  }

  function observeRoute() {
    if (state.mo) state.mo.disconnect();
    state.mo = new MutationObserver(() => { if (state.url !== location.href) routeChanged('mutation'); ensureUI(); });
    state.mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  function listenCommands() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[KEYS.SETTINGS]) {
        state.settings = { ...DEFAULT_SETTINGS, ...(changes[KEYS.SETTINGS].newValue || {}) };
        addLog('info', 'settings:changed', state.settings);
        ensureUI();
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
    try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch (_) {}
    state.routeKey = getRouteKey();
    patchHistory(); observeRoute(); listenCommands(); ensureUI();
    window.addEventListener('scroll', () => { state.lastScrollY = window.scrollY; if (state.restoring) { if (now() - state.restoreStartedAt > RESTORE.cancelGraceMs) addLog('info', 'scroll:during-restore-save-suppressed', { scrollY: Math.round(window.scrollY) }); return; } scheduleSave('scroll'); }, { passive: true });
    window.addEventListener('wheel', () => markUserInput('wheel'), { passive: true, capture: true });
    window.addEventListener('touchstart', () => markUserInput('touchstart'), { passive: true, capture: true });
    window.addEventListener('keydown', () => markUserInput('keydown'), true);
    document.addEventListener('click', (event) => { state.lastUserInputAt = now(); const target = event.target instanceof Element ? event.target : null; const link = target ? target.closest('a[href*="/status/"]') : null; if (link && supported()) savePosition('before-status-click'); }, true);
    await addLog('info', 'init', { routeKey: state.routeKey, articleCount: articles().length, settings: state.settings, scrollRestoration: history.scrollRestoration });
    fastInitialRestoreThenRefine();
  }

  init().catch((error) => console.error(PREFIX, error));
})();
