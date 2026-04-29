/*
 * X Feed Anchor Restore - content.js
 * Manifest V3 content script for X.com/Twitter.com feed anchor save & restore.
 */
(() => {
  'use strict';

  const APP = 'X Feed Anchor Restore';
  const PREFIX = `[${APP}]`;
  const STORAGE_KEYS = {
    SETTINGS: 'xfar_settings',
    POSITIONS: 'xfar_positions',
    HISTORY: 'xfar_history',
    LAST_ROUTE: 'xfar_last_route'
  };

  const DEFAULT_SETTINGS = {
    autoRestore: true,
    showButton: true,
    enableHome: true,
    enableSearch: true,
    enableLists: true,
    enableOtherTimelines: true,
    historyLimit: 10,
    debug: false,
    language: 'auto'
  };

  const STATE = {
    settings: { ...DEFAULT_SETTINGS },
    currentUrl: location.href,
    currentRouteKey: '',
    saveTimer: null,
    routeTimer: null,
    mutationObserver: null,
    isRestoring: false,
    lastSavedAnchor: null,
    lastUserIntentAt: 0,
    lastScrollY: window.scrollY,
    pendingNoticeTimer: null,
    ui: { root: null, button: null, panel: null, notice: null }
  };

  function log(type, ...args) {
    if (!STATE.settings.debug) return;
    console.log(PREFIX, type, ...args);
  }

  function now() { return Date.now(); }

  function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }

  function storageSet(data) {
    return new Promise((resolve) => chrome.storage.local.set(data, resolve));
  }

  function getBrowserLanguage() {
    const lang = (navigator.language || 'en').toLowerCase();
    return lang.startsWith('ja') ? 'ja' : 'en';
  }

  function getLanguage() {
    if (STATE.settings.language === 'ja' || STATE.settings.language === 'en') return STATE.settings.language;
    return getBrowserLanguage();
  }

  function t(key) {
    const lang = getLanguage();
    const dict = {
      ja: {
        button: '前の位置へ',
        noticeRestore: '保存位置に戻る',
        noticeFailed: '保存済みポストが見つかりませんでした',
        historyTitle: '保存履歴',
        noHistory: '履歴なし'
      },
      en: {
        button: 'Back to saved post',
        noticeRestore: 'Back to saved post',
        noticeFailed: 'Saved post was not found',
        historyTitle: 'Saved positions',
        noHistory: 'No history'
      }
    };
    return (dict[lang] && dict[lang][key]) || dict.en[key] || key;
  }

  function normalizeRouteKey(urlString = location.href) {
    const url = new URL(urlString);
    const path = url.pathname;
    if (path === '/home' || path === '/') return '/home';
    if (path === '/search') {
      const q = url.searchParams.get('q') || '';
      const f = url.searchParams.get('f') || '';
      return `/search?q=${encodeURIComponent(q)}${f ? `&f=${encodeURIComponent(f)}` : ''}`;
    }
    const listMatch = path.match(/^\/i\/lists\/([^/]+)/);
    if (listMatch) return `/i/lists/${listMatch[1]}`;
    const statusMatch = path.match(/^\/([^/]+)\/status\/(\d+)/);
    if (statusMatch) return `/status/${statusMatch[2]}`;
    return path;
  }

  function isSupportedRoute(routeKey = normalizeRouteKey()) {
    if (routeKey === '/home') return STATE.settings.enableHome;
    if (routeKey.startsWith('/search')) return STATE.settings.enableSearch;
    if (routeKey.startsWith('/i/lists/')) return STATE.settings.enableLists;
    if (routeKey.startsWith('/status/')) return false;
    return STATE.settings.enableOtherTimelines;
  }

  function queryTweetArticles() {
    const direct = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    if (direct.length) return direct;
    const cells = Array.from(document.querySelectorAll('div[data-testid="cellInnerDiv"]'));
    const articles = [];
    for (const cell of cells) {
      const article = cell.querySelector('article');
      if (article) articles.push(article);
    }
    return articles;
  }

  function extractTweetIdFromHref(href) {
    if (!href) return null;
    const match = href.match(/\/status\/(\d+)/);
    return match ? match[1] : null;
  }

  function findStatusLink(article) {
    const links = Array.from(article.querySelectorAll('a[href*="/status/"]'));
    for (const link of links) {
      const href = link.href || link.getAttribute('href') || '';
      const tweetId = extractTweetIdFromHref(href);
      if (tweetId) return { href, tweetId };
    }
    return null;
  }

  function extractSnippet(article) {
    const textNode = article.querySelector('[data-testid="tweetText"]');
    const text = (textNode ? textNode.innerText : article.innerText || '').replace(/\s+/g, ' ').trim();
    return text.slice(0, 160);
  }

  function extractAuthor(article) {
    const userName = article.querySelector('[data-testid="User-Name"]');
    const text = (userName ? userName.innerText : '').replace(/\s+/g, ' ').trim();
    return text.slice(0, 120);
  }

  function getFixedHeaderHeight() {
    const candidates = Array.from(document.querySelectorAll('[role="banner"], header, div[data-testid="TopNavBar"]'));
    let max = 0;
    for (const el of candidates) {
      const style = getComputedStyle(el);
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;
      const rect = el.getBoundingClientRect();
      if (rect.top <= 5 && rect.bottom > 0 && rect.height < 200) max = Math.max(max, rect.height);
    }
    return Math.round(max);
  }

  function getVisibleAnchor() {
    if (!isSupportedRoute()) return null;
    const articles = queryTweetArticles();
    if (!articles.length) {
      log('anchor:not-found', 'no articles');
      return null;
    }
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
    const headerOffset = getFixedHeaderHeight();
    for (const article of articles) {
      const rect = article.getBoundingClientRect();
      if (rect.bottom <= headerOffset || rect.top >= viewportHeight) continue;
      const status = findStatusLink(article);
      if (!status || !status.tweetId) continue;
      const distance = Math.abs(rect.top - headerOffset);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = {
          tweetId: status.tweetId,
          href: status.href,
          routeKey: normalizeRouteKey(),
          offsetTopFromViewport: Math.round(rect.top - headerOffset),
          scrollY: Math.round(window.scrollY),
          savedAt: now(),
          snippet: extractSnippet(article),
          author: extractAuthor(article)
        };
      }
    }
    if (!best) log('anchor:not-found', 'no visible tweet id');
    return best;
  }

  async function saveCurrentAnchor(reason = 'scroll') {
    const anchor = getVisibleAnchor();
    if (!anchor) return false;
    const data = await storageGet([STORAGE_KEYS.POSITIONS, STORAGE_KEYS.HISTORY]);
    const positions = data[STORAGE_KEYS.POSITIONS] || {};
    const history = Array.isArray(data[STORAGE_KEYS.HISTORY]) ? data[STORAGE_KEYS.HISTORY] : [];
    positions[anchor.routeKey] = anchor;
    const deduped = history.filter((item) => !(item.routeKey === anchor.routeKey && item.tweetId === anchor.tweetId));
    deduped.unshift(anchor);
    const limit = Math.max(1, Math.min(Number(STATE.settings.historyLimit) || 10, 50));
    const nextHistory = deduped.slice(0, limit);
    STATE.lastSavedAnchor = anchor;
    await storageSet({
      [STORAGE_KEYS.POSITIONS]: positions,
      [STORAGE_KEYS.HISTORY]: nextHistory,
      [STORAGE_KEYS.LAST_ROUTE]: anchor.routeKey
    });
    log('save', reason, anchor);
    return true;
  }

  function scheduleSave(reason = 'scroll', delay = 500) {
    if (STATE.isRestoring) return;
    clearTimeout(STATE.saveTimer);
    STATE.saveTimer = setTimeout(() => saveCurrentAnchor(reason), delay);
  }

  function findArticleByTweetId(tweetId) {
    const id = String(tweetId).replace(/[^\d]/g, '');
    const link = document.querySelector(`a[href*="/status/${id}"]`);
    if (!link) return null;
    return link.closest('article') || link.closest('div[data-testid="cellInnerDiv"]');
  }

  async function getSavedAnchorForRoute(routeKey = normalizeRouteKey()) {
    const data = await storageGet([STORAGE_KEYS.POSITIONS]);
    const positions = data[STORAGE_KEYS.POSITIONS] || {};
    return positions[routeKey] || null;
  }

  async function restoreForCurrentRoute(reason = 'auto', explicitAnchor = null) {
    if (!STATE.settings.autoRestore && reason !== 'manual' && reason !== 'history') return false;
    const routeKey = normalizeRouteKey();
    if (!isSupportedRoute(routeKey) && reason !== 'history') return false;
    const anchor = explicitAnchor || await getSavedAnchorForRoute(routeKey);
    if (!anchor || !anchor.tweetId) {
      log('restore:skip', reason, 'no anchor', routeKey);
      return false;
    }
    log('restore:start', reason, anchor);
    const ok = await waitAndScrollToAnchor(anchor, reason);
    if (!ok && reason === 'manual') showNotice(t('noticeFailed'), false);
    return ok;
  }

  function waitAndScrollToAnchor(anchor, reason) {
    return new Promise((resolve) => {
      const startedAt = now();
      const timeoutMs = 10000;
      let attempts = 0;
      let done = false;
      let observer = null;
      let interval = null;
      const finish = (ok) => {
        if (done) return;
        done = true;
        if (interval) clearInterval(interval);
        if (observer) observer.disconnect();
        STATE.isRestoring = false;
        log(ok ? 'restore:success' : 'restore:failed', reason, anchor, { attempts });
        resolve(ok);
      };
      const tryRestore = () => {
        attempts += 1;
        const target = findArticleByTweetId(anchor.tweetId);
        if (!target) {
          if (now() - startedAt > timeoutMs) finish(false);
          return;
        }
        STATE.isRestoring = true;
        target.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' });
        requestAnimationFrame(() => {
          const header = getFixedHeaderHeight();
          const desired = Number(anchor.offsetTopFromViewport) || 0;
          const rect = target.getBoundingClientRect();
          const delta = Math.round((rect.top - header) - desired);
          if (Math.abs(delta) > 2) window.scrollBy(0, delta);
          stabilizeRestore(target, anchor, startedAt);
          finish(true);
        });
      };
      observer = new MutationObserver(() => { if (!done) tryRestore(); });
      observer.observe(document.body, { childList: true, subtree: true });
      interval = setInterval(tryRestore, 250);
      tryRestore();
    });
  }

  function stabilizeRestore(target, anchor, startedAt) {
    const durationMs = 1800;
    const tick = () => {
      if (now() - startedAt > durationMs) return;
      if (!document.contains(target)) return;
      const header = getFixedHeaderHeight();
      const desired = Number(anchor.offsetTopFromViewport) || 0;
      const rect = target.getBoundingClientRect();
      const delta = Math.round((rect.top - header) - desired);
      if (Math.abs(delta) > 12) window.scrollBy(0, delta);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function markUserIntent() { STATE.lastUserIntentAt = now(); }

  function shouldOfferJumpRecovery(currentY, previousY, delta) {
    if (!STATE.lastSavedAnchor) return false;
    if (STATE.lastSavedAnchor.routeKey !== normalizeRouteKey()) return false;
    if (now() - STATE.lastSavedAnchor.savedAt > 5000) return false;
    if (now() - STATE.lastUserIntentAt < 1500) return false;
    if (previousY < 800) return false;
    if (currentY > previousY) return false;
    return Math.abs(delta) > 700 || currentY < previousY * 0.35;
  }

  function onScroll() {
    const currentY = window.scrollY;
    const previousY = STATE.lastScrollY;
    const delta = currentY - previousY;
    STATE.lastScrollY = currentY;
    scheduleSave('scroll', 500);
    if (STATE.settings.autoRestore && shouldOfferJumpRecovery(currentY, previousY, delta)) {
      showNotice(t('noticeRestore'), true);
    }
  }

  function showNotice(message, withAction) {
    ensureUI();
    if (!STATE.ui.notice) return;
    STATE.ui.notice.textContent = message;
    STATE.ui.notice.style.display = 'block';
    STATE.ui.notice.onclick = withAction ? () => restoreForCurrentRoute('manual') : null;
    clearTimeout(STATE.pendingNoticeTimer);
    STATE.pendingNoticeTimer = setTimeout(() => {
      if (STATE.ui.notice) STATE.ui.notice.style.display = 'none';
    }, 6000);
  }

  function ensureUI() {
    if (!STATE.settings.showButton) { removeUI(); return; }
    if (STATE.ui.root && document.contains(STATE.ui.root)) return;
    const root = document.createElement('div');
    root.id = 'xfar-root';
    root.style.cssText = 'position:fixed;right:16px;bottom:18px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;line-height:1.35;color:#0f1419';
    const notice = document.createElement('div');
    notice.style.cssText = 'display:none;margin-bottom:8px;padding:8px 10px;border-radius:999px;background:rgba(15,20,25,.92);color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.22);cursor:pointer;max-width:260px;text-align:center';
    const panel = document.createElement('div');
    panel.style.cssText = 'display:none;width:320px;max-height:360px;overflow:auto;margin-bottom:8px;border:1px solid rgba(83,100,113,.25);border-radius:14px;background:rgba(255,255,255,.98);box-shadow:0 8px 28px rgba(0,0,0,.24);padding:10px';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = t('button');
    button.title = `${t('button')} / Shift+Click: ${t('historyTitle')}`;
    button.style.cssText = 'border:1px solid rgba(83,100,113,.35);border-radius:999px;background:rgba(255,255,255,.94);color:#0f1419;padding:8px 12px;font-weight:700;box-shadow:0 4px 16px rgba(0,0,0,.18);cursor:pointer;backdrop-filter:blur(8px)';
    button.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation();
      if (event.shiftKey) toggleHistoryPanel();
      else restoreForCurrentRoute('manual');
    });
    root.appendChild(notice); root.appendChild(panel); root.appendChild(button);
    document.documentElement.appendChild(root);
    STATE.ui.root = root; STATE.ui.button = button; STATE.ui.panel = panel; STATE.ui.notice = notice;
  }

  function removeUI() {
    if (STATE.ui.root && STATE.ui.root.parentNode) STATE.ui.root.parentNode.removeChild(STATE.ui.root);
    STATE.ui.root = null; STATE.ui.button = null; STATE.ui.panel = null; STATE.ui.notice = null;
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }

  async function toggleHistoryPanel() {
    ensureUI();
    const panel = STATE.ui.panel;
    if (!panel) return;
    if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
    const data = await storageGet([STORAGE_KEYS.HISTORY]);
    const history = Array.isArray(data[STORAGE_KEYS.HISTORY]) ? data[STORAGE_KEYS.HISTORY] : [];
    panel.innerHTML = '';
    const title = document.createElement('div');
    title.textContent = t('historyTitle');
    title.style.cssText = 'font-weight:800;margin:0 0 8px;font-size:14px;';
    panel.appendChild(title);
    if (!history.length) {
      const empty = document.createElement('div');
      empty.textContent = t('noHistory');
      empty.style.cssText = 'color:#536471;padding:8px 0;';
      panel.appendChild(empty);
    }
    for (const item of history) {
      const row = document.createElement('button');
      row.type = 'button';
      const date = new Date(item.savedAt || Date.now()).toLocaleString();
      row.innerHTML = `<strong>${escapeHtml(item.routeKey || '')}</strong><br><span>${escapeHtml(item.author || '')}</span><br><small>${escapeHtml(item.snippet || item.tweetId || '')}</small><br><small>${escapeHtml(date)}</small>`;
      row.style.cssText = 'display:block;width:100%;text-align:left;border:0;border-top:1px solid rgba(83,100,113,.18);background:transparent;padding:8px 4px;cursor:pointer;color:#0f1419';
      row.addEventListener('click', (event) => {
        event.preventDefault(); event.stopPropagation(); panel.style.display = 'none';
        if (normalizeRouteKey() !== item.routeKey && item.routeKey && !item.routeKey.startsWith('/status/')) {
          history.pushState({}, '', item.routeKey);
          handleRouteChange('history-panel');
          setTimeout(() => restoreForCurrentRoute('history', item), 700);
        } else {
          restoreForCurrentRoute('history', item);
        }
      });
      panel.appendChild(row);
    }
    panel.style.display = 'block';
  }

  function patchHistory() {
    if (window.__xfarHistoryPatched) return;
    window.__xfarHistoryPatched = true;
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function patchedPushState(...args) {
      saveCurrentAnchor('before-pushState');
      const result = originalPushState.apply(this, args);
      setTimeout(() => handleRouteChange('pushState'), 0);
      return result;
    };
    history.replaceState = function patchedReplaceState(...args) {
      const result = originalReplaceState.apply(this, args);
      setTimeout(() => handleRouteChange('replaceState'), 0);
      return result;
    };
    window.addEventListener('popstate', () => {
      saveCurrentAnchor('before-popstate');
      setTimeout(() => handleRouteChange('popstate'), 60);
    });
  }

  function handleRouteChange(reason) {
    if (STATE.currentUrl === location.href) return;
    const oldUrl = STATE.currentUrl;
    STATE.currentUrl = location.href;
    STATE.currentRouteKey = normalizeRouteKey();
    log('route', reason, { oldUrl, newUrl: location.href, routeKey: STATE.currentRouteKey });
    ensureUI();
    clearTimeout(STATE.routeTimer);
    STATE.routeTimer = setTimeout(() => restoreForCurrentRoute(reason), 700);
  }

  function setupMutationObserver() {
    if (STATE.mutationObserver) STATE.mutationObserver.disconnect();
    STATE.mutationObserver = new MutationObserver(() => {
      if (STATE.currentUrl !== location.href) handleRouteChange('mutation-url');
      ensureUI();
    });
    STATE.mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function setupEventListeners() {
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('keydown', (event) => {
      if (['Home', 'PageUp', 'PageDown', 'End', 'ArrowUp', 'ArrowDown', 'Space'].includes(event.code)) markUserIntent();
    }, true);
    window.addEventListener('wheel', markUserIntent, { passive: true, capture: true });
    window.addEventListener('touchstart', markUserIntent, { passive: true, capture: true });
    document.addEventListener('click', (event) => {
      markUserIntent();
      const target = event.target instanceof Element ? event.target : null;
      const link = target ? target.closest('a[href*="/status/"]') : null;
      if (link && isSupportedRoute()) saveCurrentAnchor('before-status-click');
    }, true);
    window.addEventListener('load', () => setTimeout(() => restoreForCurrentRoute('load'), 900));
  }

  async function loadSettings() {
    const data = await storageGet([STORAGE_KEYS.SETTINGS]);
    STATE.settings = { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.SETTINGS] || {}) };
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEYS.SETTINGS]) {
      STATE.settings = { ...DEFAULT_SETTINGS, ...(changes[STORAGE_KEYS.SETTINGS].newValue || {}) };
      log('settings:changed', STATE.settings);
      ensureUI();
      if (STATE.ui.button) STATE.ui.button.textContent = t('button');
    }
  });

  async function init() {
    await loadSettings();
    STATE.currentRouteKey = normalizeRouteKey();
    patchHistory();
    setupEventListeners();
    setupMutationObserver();
    ensureUI();
    scheduleSave('init', 1200);
    setTimeout(() => restoreForCurrentRoute('init'), 1200);
    log('init', { routeKey: STATE.currentRouteKey, settings: STATE.settings });
  }

  init().catch((error) => console.error(PREFIX, 'init:error', error));
})();
