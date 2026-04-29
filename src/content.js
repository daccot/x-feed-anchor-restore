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

  const CONFIG = {
    saveDebounceMs: 700,
    restoreTimeoutMs: 9000,
    restorePollMs: 300,
    initialReadyMinArticles: 6,
    initialReadyTimeoutMs: 8000,
    adjustDelayMs: 300,
    driftCheckDelayMs: 900,
    driftThresholdPx: 220,
    nearbyRangePx: 500,
    nearbyLimit: 20,
    historyCandidateThreshold: 95,
    normalCandidateThreshold: 80,
    virtualLoadStepPx: 900,
    virtualLoadMaxSteps: 3,
    logLimit: 300
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
    initialStarted: false,
    lastUserInputAt: 0,
    ui: {
      root: null,
      status: null,
      debug: null,
      historyPanel: null
    },
    routeObserver: null
  };

  try {
    if ('scrollRestoration' in history) {
      history.scrollRestoration = 'manual';
    }
  } catch (_) {}

  const now = () => Date.now();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const storageGet = (keys) => new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  const storageSet = (obj) => new Promise((resolve) => chrome.storage.local.set(obj, resolve));

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

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"]/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;'
    }[ch]));
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

    if (state.settings.debug) {
      console.log(PREFIX, entry);
    }

    try {
      const data = await storageGet([KEYS.LOGS]);
      const logs = Array.isArray(data[KEYS.LOGS]) ? data[KEYS.LOGS] : [];
      logs.unshift(entry);
      await storageSet({ [KEYS.LOGS]: logs.slice(0, CONFIG.logLimit) });
    } catch (error) {
      console.warn(PREFIX, 'log write failed', error);
    }

    updateDebug(entry);
  }

  function getLanguage() {
    if (state.settings.language === 'ja' || state.settings.language === 'en') {
      return state.settings.language;
    }
    return (navigator.language || '').toLowerCase().startsWith('ja') ? 'ja' : 'en';
  }

  function t(key) {
    const ja = {
      save: '保存',
      restore: '前の位置へ',
      history: '履歴',
      saved: '保存しました',
      restored: '復元しました',
      restoredByScroll: 'スクロール位置で復元しました',
      loading: '復元中...',
      waiting: 'タイムライン読み込み待機中...',
      corrected: 'ズレを補正しました',
      cancelled: 'ユーザー操作により中断しました',
      noSaved: '保存位置なし',
      historyTitle: '復元履歴',
      noHistory: '履歴なし'
    };

    const en = {
      save: 'Save',
      restore: 'Back',
      history: 'History',
      saved: 'Saved',
      restored: 'Restored',
      restoredByScroll: 'Restored by scroll position',
      loading: 'Loading...',
      waiting: 'Waiting for timeline...',
      corrected: 'Drift corrected',
      cancelled: 'Cancelled by user',
      noSaved: 'No saved position',
      historyTitle: 'Restore history',
      noHistory: 'No history'
    };

    return (getLanguage() === 'ja' ? ja : en)[key] || key;
  }

  function getRouteKey(urlString = location.href) {
    const u = new URL(urlString);
    const p = u.pathname;

    if (p === '/' || p === '/home') return '/home';

    if (p === '/search') {
      return '/search?q=' + encodeURIComponent(u.searchParams.get('q') || '') +
        '&f=' + encodeURIComponent(u.searchParams.get('f') || '');
    }

    const list = p.match(/^\/i\/lists\/([^/]+)/);
    if (list) return '/i/lists/' + list[1];

    const status = p.match(/^\/([^/]+)\/status\/(\d+)/);
    if (status) return '/status/' + status[2];

    return p;
  }

  function isSupportedRoute(routeKey = getRouteKey()) {
    if (routeKey === '/home') return state.settings.enableHome;
    if (routeKey.startsWith('/search')) return state.settings.enableSearch;
    if (routeKey.startsWith('/i/lists/')) return state.settings.enableLists;
    if (routeKey.startsWith('/status/')) return false;
    return state.settings.enableOtherTimelines;
  }

  function uniqueElements(elements) {
    const seen = new Set();
    const out = [];
    for (const el of elements) {
      if (!el || seen.has(el)) continue;
      seen.add(el);
      out.push(el);
    }
    return out;
  }

  function articles() {
    return uniqueElements([
      ...document.querySelectorAll('article[data-testid="tweet"]'),
      ...document.querySelectorAll('div[data-testid="cellInnerDiv"] article[data-testid="tweet"]'),
      ...document.querySelectorAll('div[data-testid="cellInnerDiv"] article'),
      ...document.querySelectorAll('div[data-testid="cellInnerDiv"] [data-testid="tweet"]')
    ]).map((el) => el.closest('article') || el).filter(Boolean);
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
      if ((s.position === 'fixed' || s.position === 'sticky') && r.top <= 5 && r.height < 180) {
        h = Math.max(h, r.height);
      }
    }
    return Math.round(h);
  }

  function tweetText(article) {
    const tNode = article.querySelector('[data-testid="tweetText"]');
    return ((tNode && tNode.innerText) || '').replace(/\s+/g, ' ').trim();
  }

  function snippet(article) {
    const explicit = tweetText(article);
    const fallback = (article.innerText || '').replace(/\s+/g, ' ').trim();
    return (explicit || fallback).slice(0, 180);
  }

  function author(article) {
    const u = article.querySelector('[data-testid="User-Name"]');
    return ((u && u.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  function normalizeForScore(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^\p{L}\p{N}@#ーぁ-んァ-ヶ一-龠 ]/gu, '')
      .trim();
  }

  function tokenSet(value) {
    const normalized = normalizeForScore(value);
    if (!normalized) return new Set();
    return new Set(normalized.split(' ').filter(Boolean));
  }

  function textSimilarity(a, b) {
    const aa = tokenSet(a);
    const bb = tokenSet(b);
    if (!aa.size || !bb.size) return 0;

    let hit = 0;
    for (const token of aa) {
      if (bb.has(token)) hit++;
    }

    return hit / Math.max(aa.size, bb.size);
  }

  function visibleAnchor() {
    if (!isSupportedRoute()) return null;

    const hs = headerHeight();
    const vh = window.innerHeight || 800;
    const currentY = Math.round(window.scrollY);
    const list = articles();
    const visible = [];
    const nearby = [];

    for (const article of list) {
      const info = statusInfo(article);
      if (!info) continue;

      const rect = article.getBoundingClientRect();
      const absTop = Math.round(currentY + rect.top);
      const fullyVisible = rect.top >= hs && rect.bottom <= vh;
      const partiallyVisible = rect.bottom > hs && rect.top < vh;
      const text = tweetText(article);

      const item = {
        article,
        info,
        rect,
        absTop,
        fullyVisible,
        partiallyVisible,
        textLength: text.length,
        distanceFromTop: Math.abs(rect.top - hs)
      };

      if (partiallyVisible) {
        visible.push(item);
      }

      if (Math.abs(absTop - currentY) <= CONFIG.nearbyRangePx) {
        nearby.push({
          tweetId: info.tweetId,
          href: info.href,
          absTop,
          rect: rectToObject(rect),
          author: author(article),
          snippet: snippet(article),
          textLength: text.length
        });
      }
    }

    if (!visible.length) {
      addLog('warn', 'anchor:no-visible-candidates', {
        articleCount: list.length,
        scrollY: currentY
      });
      return null;
    }

    visible.sort((a, b) => a.rect.top - b.rect.top);
    nearby.sort((a, b) => b.textLength - a.textLength);

    const fullyVisible = visible.filter((x) => x.fullyVisible);
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
      scrollY: currentY,
      savedAt: now(),
      author: author(best.article),
      snippet: snippet(best.article),
      textLength: tweetText(best.article).length,
      articleCount: list.length,
      visibleCount: visible.length,
      fullyVisibleCount: fullyVisible.length,
      headerHeight: hs,
      viewportHeight: vh,
      selectedRect: rectToObject(r),
      nearbyAnchors: nearby.slice(0, CONFIG.nearbyLimit)
    };

    addLog('info', 'anchor:selected', {
      tweetId: anchor.tweetId,
      routeKey: anchor.routeKey,
      scrollY: anchor.scrollY,
      nearbyCount: anchor.nearbyAnchors.length
    });

    return anchor;
  }

  async function savePosition(reason = 'auto') {
    if (state.restoring && !String(reason).startsWith('manual')) {
      await addLog('info', 'save:suppressed-during-restore', { reason });
      return false;
    }

    const anchor = visibleAnchor();
    if (!anchor) {
      await addLog('warn', 'save:no-anchor', {
        reason,
        routeKey: getRouteKey(),
        articleCount: articles().length
      });
      return false;
    }

    const data = await storageGet([KEYS.POSITIONS, KEYS.HISTORY]);
    const positions = data[KEYS.POSITIONS] || {};
    const history = Array.isArray(data[KEYS.HISTORY]) ? data[KEYS.HISTORY] : [];

    positions[anchor.routeKey] = anchor;

    const nextHistory = [
      anchor,
      ...history.filter((item) => !(item.routeKey === anchor.routeKey && item.tweetId === anchor.tweetId))
    ].slice(0, state.settings.historyLimit || 20);

    await storageSet({
      [KEYS.POSITIONS]: positions,
      [KEYS.HISTORY]: nextHistory
    });

    setStatus(`${t('saved')}: ${anchor.routeKey}`);
    await addLog('info', 'save:ok', { reason, anchor });
    return true;
  }

  function scoreCandidate(article, saved) {
    const info = statusInfo(article);
    if (!info || !saved) return { score: -1 };

    const rect = article.getBoundingClientRect();
    const absTop = Math.round(window.scrollY + rect.top);
    const articleAuthor = author(article);
    const articleSnippet = snippet(article);

    let score = 0;
    const reasons = [];

    if (String(info.tweetId) === String(saved.tweetId)) {
      score += 120;
      reasons.push('tweetId:+120');
    }

    if (Array.isArray(saved.nearbyAnchors) &&
        saved.nearbyAnchors.some((x) => String(x.tweetId) === String(info.tweetId))) {
      score += 75;
      reasons.push('nearbyTweetId:+75');
    }

    const authorSim = textSimilarity(articleAuthor, saved.author);
    if (authorSim > 0) {
      const v = Math.round(authorSim * 30);
      score += v;
      reasons.push(`author:+${v}`);
    }

    const snippetSim = textSimilarity(articleSnippet, saved.snippet);
    if (snippetSim > 0) {
      const v = Math.round(snippetSim * 35);
      score += v;
      reasons.push(`snippet:+${v}`);
    }

    if (typeof saved.scrollY === 'number') {
      const dist = Math.abs(absTop - saved.scrollY);
      const v = Math.max(0, Math.round(25 - dist / 80));
      if (v > 0) {
        score += v;
        reasons.push(`scrollDistance:+${v}`);
      }
    }

    if (typeof saved.offsetTopFromViewport === 'number') {
      const hs = headerHeight();
      const offsetDist = Math.abs((rect.top - hs) - saved.offsetTopFromViewport);
      const v = Math.max(0, Math.round(20 - offsetDist / 20));
      if (v > 0) {
        score += v;
        reasons.push(`viewportOffset:+${v}`);
      }
    }

    return {
      score,
      article,
      info,
      rect: rectToObject(rect),
      absTop,
      author: articleAuthor,
      snippet: articleSnippet,
      reasons
    };
  }

  async function findBestCandidate(saved, options = {}) {
    const list = articles();
    let best = null;
    const scored = [];

    for (const article of list) {
      const result = scoreCandidate(article, saved);
      if (result.score < 0) continue;

      scored.push({
        tweetId: result.info.tweetId,
        score: result.score,
        reasons: result.reasons,
        rect: result.rect,
        absTop: result.absTop,
        snippet: result.snippet ? result.snippet.slice(0, 80) : ''
      });

      if (!best || result.score > best.score) {
        best = result;
      }
    }

    scored.sort((a, b) => b.score - a.score);

    await addLog('info', options.historyMode ? 'history:candidate-score' : 'restore:candidate-score', {
      savedTweetId: saved && saved.tweetId,
      savedScrollY: saved && saved.scrollY,
      top: scored.slice(0, 8)
    });

    return { best, scored };
  }

  function markUserInput(source) {
    state.lastUserInputAt = now();

    if (state.restoring && now() - state.restoreStartedAt > CONFIG.cancelGraceMs) {
      state.restoreCancelled = true;
      setStatus(t('cancelled'));
      addLog('warn', 'restore:cancel-requested-by-user', { source });
    }
  }

  function restoreCancelled(sessionId) {
    return state.restoreCancelled || sessionId !== state.restoreSessionId;
  }

  async function adjustToTarget(article, saved, sessionId, label) {
    article.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' });
    await sleep(CONFIG.adjustDelayMs);

    if (restoreCancelled(sessionId)) {
      return { cancelled: true };
    }

    const hs1 = headerHeight();
    const rect1 = article.getBoundingClientRect();
    const desired = Number(saved.offsetTopFromViewport) || 0;
    const delta1 = Math.round((rect1.top - hs1) - desired);

    if (Math.abs(delta1) > 2) {
      window.scrollBy(0, delta1);
    }

    await sleep(160);

    const hs2 = headerHeight();
    const rect2 = article.getBoundingClientRect();
    const delta2 = Math.round((rect2.top - hs2) - desired);

    if (Math.abs(delta2) > 2) {
      window.scrollBy(0, delta2);
    }

    await sleep(80);

    const rect3 = article.getBoundingClientRect();

    await addLog('info', 'restore:adjusted', {
      sessionId,
      label,
      desiredOffset: desired,
      delta1,
      delta2,
      rect1: rectToObject(rect1),
      rect2: rectToObject(rect2),
      rect3: rectToObject(rect3),
      finalScrollY: Math.round(window.scrollY)
    });

    return {
      cancelled: false,
      delta1,
      delta2,
      finalRect: rectToObject(rect3)
    };
  }

  function scheduleDriftCheck(article, saved, sessionId) {
    clearTimeout(state.driftTimer);
    if (!article || !saved) return;

    state.driftTimer = setTimeout(async () => {
      if (state.restoring || restoreCancelled(sessionId)) return;
      if (now() - state.lastUserInputAt < 1200) return;
      if (!document.contains(article)) return;

      const hs = headerHeight();
      const rect = article.getBoundingClientRect();
      const desired = Number(saved.offsetTopFromViewport) || 0;
      const drift = Math.round((rect.top - hs) - desired);

      if (Math.abs(drift) >= CONFIG.driftThresholdPx) {
        window.scrollBy(0, drift);
        setStatus(t('corrected'));
        await addLog('info', 'drift:auto-corrected', {
          sessionId,
          drift,
          rect: rectToObject(rect),
          desiredOffset: desired
        });
      } else {
        await addLog('info', 'drift:checked', {
          sessionId,
          drift,
          rect: rectToObject(rect),
          desiredOffset: desired
        });
      }
    }, CONFIG.driftCheckDelayMs);
  }

  async function restoreAnchorObject(saved, reason = 'history') {
    if (!saved) return false;

    await addLog('info', 'history:click', {
      tweetId: saved.tweetId,
      routeKey: saved.routeKey,
      scrollY: saved.scrollY,
      author: saved.author,
      snippet: saved.snippet
    });

    if (saved.routeKey && saved.routeKey !== getRouteKey() && !saved.routeKey.startsWith('/status/')) {
      history.pushState({}, '', saved.routeKey);
      state.url = location.href;
      state.routeKey = getRouteKey();
      await sleep(300);
    }

    if (typeof saved.scrollY === 'number' && saved.scrollY > 0) {
      window.scrollTo(0, saved.scrollY);
      await addLog('info', 'history:scrollY-jump', {
        tweetId: saved.tweetId,
        scrollY: saved.scrollY
      });
      await sleep(120);
    }

    return restorePosition(reason, {
      explicitSaved: saved,
      historyMode: true,
      noVirtualLoad: true,
      silent: true
    });
  }

  async function restorePosition(reason = 'auto', options = {}) {
    if (!state.settings.autoRestore && reason === 'auto') return false;

    const routeKey = getRouteKey();
    if (!isSupportedRoute(routeKey) && !options.explicitSaved) {
      await addLog('info', 'restore:skip-unsupported-route', { reason, routeKey });
      return false;
    }

    const data = await storageGet([KEYS.POSITIONS]);
    const saved = options.explicitSaved || (data[KEYS.POSITIONS] || {})[routeKey];

    if (!saved) {
      setStatus(t('noSaved'));
      await addLog('warn', 'restore:no-saved-position', { reason, routeKey });
      return false;
    }

    const sessionId = ++state.restoreSessionId;
    state.restoring = true;
    state.restoreCancelled = false;
    state.restoreStartedAt = now();

    if (!options.silent) {
      setStatus(t('loading'), 3000);
    }

    await addLog('info', 'restore:start', {
      reason,
      sessionId,
      routeKey,
      saved,
      historyMode: Boolean(options.historyMode),
      noVirtualLoad: Boolean(options.noVirtualLoad)
    });

    let didScrollFallback = false;
    let found = false;
    let virtualLoadSteps = 0;
    let attempts = 0;

    try {
      if (typeof saved.scrollY === 'number' && saved.scrollY > 0) {
        window.scrollTo(0, saved.scrollY);
        didScrollFallback = true;
        await addLog('info', options.historyMode ? 'history:scrollY-jump' : 'restore:fallback-scrollY', {
          sessionId,
          scrollY: saved.scrollY
        });

        if (options.fast || options.historyMode) {
          setStatus(t('restoredByScroll'));
        }

        await sleep(options.fast ? 60 : 160);
      }

      const started = now();

      while (now() - started < CONFIG.restoreTimeoutMs) {
        if (restoreCancelled(sessionId)) {
          await addLog('warn', 'restore:cancelled', { sessionId, attempts });
          return false;
        }

        attempts++;

        const { best } = await findBestCandidate(saved, {
          historyMode: Boolean(options.historyMode)
        });

        const threshold = options.historyMode ? CONFIG.historyCandidateThreshold : CONFIG.normalCandidateThreshold;

        if (best && best.score >= threshold) {
          await addLog('info', options.historyMode ? 'history:best-candidate' : 'restore:best-candidate', {
            sessionId,
            attempts,
            score: best.score,
            reasons: best.reasons,
            tweetId: best.info.tweetId,
            savedTweetId: saved.tweetId,
            rect: best.rect,
            absTop: best.absTop,
            currentScrollY: Math.round(window.scrollY)
          });

          const adjusted = await adjustToTarget(best.article, saved, sessionId, `score:${best.score}`);

          if (adjusted.cancelled) {
            return false;
          }

          found = true;
          setStatus(`${t('restored')}: ${saved.tweetId}`);
          await addLog('info', options.historyMode ? 'history:anchor-ok' : 'restore:anchor-ok', {
            sessionId,
            attempts,
            score: best.score,
            tweetId: best.info.tweetId,
            savedTweetId: saved.tweetId,
            adjusted
          });

          scheduleDriftCheck(best.article, saved, sessionId);
          break;
        }

        if (options.historyMode && attempts >= 8) {
          break;
        }

        if (!options.noVirtualLoad &&
            !options.historyMode &&
            attempts >= 6 &&
            virtualLoadSteps < CONFIG.virtualLoadMaxSteps) {
          virtualLoadSteps++;
          window.scrollBy(0, CONFIG.virtualLoadStepPx);
          await addLog('info', 'restore:virtual-load-scroll', {
            sessionId,
            attempts,
            virtualLoadSteps,
            stepPx: CONFIG.virtualLoadStepPx,
            scrollY: Math.round(window.scrollY)
          });
          await sleep(500);
        } else {
          await sleep(CONFIG.restorePollMs);
        }
      }

      if (!found) {
        if (options.historyMode && typeof saved.scrollY === 'number' && saved.scrollY > 0) {
          window.scrollTo(0, saved.scrollY);
          await addLog('info', 'history:preserve-scrollY', {
            sessionId,
            tweetId: saved.tweetId,
            scrollY: saved.scrollY,
            attempts,
            virtualLoadSteps,
            articleCount: articles().length
          });
          setStatus(t('restoredByScroll'));
          return true;
        }

        setStatus(didScrollFallback ? t('restoredByScroll') : t('noSaved'));
        await addLog('warn', 'restore:anchor-not-found', {
          sessionId,
          attempts,
          virtualLoadSteps,
          tweetId: saved.tweetId,
          didScrollFallback,
          savedScrollY: saved.scrollY,
          currentScrollY: Math.round(window.scrollY),
          articleCount: articles().length
        });
      }

      return found;
    } finally {
      setTimeout(() => {
        if (sessionId === state.restoreSessionId) {
          state.restoring = false;
          state.restoreCancelled = false;
        }
      }, 700);
    }
  }

  async function waitForTimelineReady() {
    const started = now();
    await addLog('info', 'timeline-ready:wait-start', {
      minArticles: CONFIG.initialReadyMinArticles
    });

    return new Promise((resolve) => {
      let done = false;
      let interval = null;
      let observer = null;

      const finish = (ok, why) => {
        if (done) return;
        done = true;
        if (interval) clearInterval(interval);
        if (observer) observer.disconnect();

        addLog(ok ? 'info' : 'warn', 'timeline-ready:finish', {
          ok,
          why,
          elapsedMs: now() - started,
          articleCount: articles().length
        });

        resolve(ok);
      };

      const check = () => {
        const count = articles().length;
        if (count >= CONFIG.initialReadyMinArticles) finish(true, 'article-count');
        else if (now() - started >= CONFIG.initialReadyTimeoutMs) finish(false, 'timeout');
      };

      observer = new MutationObserver(check);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      interval = setInterval(check, 250);
      check();
    });
  }

  async function fastInitialRestoreThenRefine() {
    if (!isSupportedRoute()) return;
    if (state.initialStarted) return;

    state.initialStarted = true;

    await restorePosition('initial-fast', {
      fast: true,
      silent: true
    });

    await waitForTimelineReady();

    await restorePosition('initial-refine', {
      silent: true
    });
  }

  function scheduleSave(reason) {
    if (state.restoring) return;

    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      savePosition(reason);
    }, CONFIG.saveDebounceMs);
  }

  function setStatus(message, minMs = 1500) {
    ensureUI();

    if (!state.ui.status) return;

    state.ui.status.textContent = message;
    state.ui.status.style.display = 'block';

    clearTimeout(state.statusTimer);
    state.statusTimer = setTimeout(() => {
      if (state.ui.status) {
        state.ui.status.style.display = 'none';
      }
    }, Math.max(1500, minMs));
  }

  function updateDebug(entry) {
    ensureUI();

    if (!state.ui.debug) return;

    if (!state.settings.debug) {
      state.ui.debug.style.display = 'none';
      return;
    }

    state.ui.debug.style.display = 'block';
    state.ui.debug.textContent = entry
      ? [
          `${entry.level} ${entry.event}`,
          `route=${entry.routeKey}`,
          `Y=${entry.scrollY}`,
          `time=${entry.time}`
        ].join('\n')
      : '';
  }

  async function toggleHistoryPanel() {
    ensureUI();

    const panel = state.ui.historyPanel;
    if (!panel) return;

    if (panel.style.display !== 'none') {
      panel.style.display = 'none';
      return;
    }

    const data = await storageGet([KEYS.HISTORY]);
    const history = Array.isArray(data[KEYS.HISTORY]) ? data[KEYS.HISTORY] : [];

    panel.innerHTML = `<div style="font-weight:700;margin-bottom:8px;">${escapeHtml(t('historyTitle'))}</div>`;

    if (!history.length) {
      panel.innerHTML += `<div style="color:#536471;padding:8px 0;">${escapeHtml(t('noHistory'))}</div>`;
    }

    for (const item of history.slice(0, state.settings.historyLimit || 20)) {
      const row = document.createElement('button');
      row.type = 'button';
      row.style.cssText = [
        'display:block',
        'width:100%',
        'text-align:left',
        'border:0',
        'border-top:1px solid rgba(83,100,113,.25)',
        'background:transparent',
        'color:#0f1419',
        'padding:8px 4px',
        'cursor:pointer'
      ].join(';');

      const date = item.savedAt ? new Date(item.savedAt).toLocaleString() : '';

      row.innerHTML = [
        `<strong>${escapeHtml(item.routeKey || '')}</strong>`,
        `<br><small>${escapeHtml(item.author || '')}</small>`,
        `<br><span>${escapeHtml(item.snippet || item.tweetId || '')}</span>`,
        `<br><small>${escapeHtml(date)}</small>`
      ].join('');

      row.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();

        panel.style.display = 'none';
        restoreAnchorObject(item, 'history-panel');
      }, true);

      panel.appendChild(row);
    }

    panel.style.display = 'block';
  }

  function ensureUI() {
    if (!state.settings.showButton) {
      removeUI();
      return;
    }

    if (state.ui.root && document.contains(state.ui.root)) return;

    const root = document.createElement('div');
    root.id = 'xfar-root';
    root.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:18px',
      'z-index:2147483647',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'font-size:12px',
      'color:#0f1419',
      'display:flex',
      'flex-direction:column',
      'gap:6px',
      'align-items:flex-end'
    ].join(';');

    const status = document.createElement('div');
    status.style.cssText = [
      'max-width:300px',
      'background:rgba(15,20,25,.92)',
      'color:#fff',
      'padding:7px 10px',
      'border-radius:12px',
      'box-shadow:0 4px 16px rgba(0,0,0,.2)',
      'display:none',
      'white-space:pre-wrap'
    ].join(';');

    const debug = document.createElement('pre');
    debug.style.cssText = [
      'max-width:300px',
      'background:rgba(255,255,255,.94)',
      'border:1px solid rgba(83,100,113,.35)',
      'padding:6px 8px',
      'border-radius:10px',
      'margin:0',
      'display:none',
      'white-space:pre-wrap'
    ].join(';');

    const historyPanel = document.createElement('div');
    historyPanel.style.cssText = [
      'display:none',
      'width:340px',
      'max-height:420px',
      'overflow:auto',
      'background:rgba(255,255,255,.98)',
      'border:1px solid rgba(83,100,113,.35)',
      'border-radius:14px',
      'box-shadow:0 8px 28px rgba(0,0,0,.24)',
      'padding:10px'
    ].join(';');

    const box = document.createElement('div');
    box.style.cssText = 'display:flex;gap:6px;';

    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.textContent = t('save');
    saveButton.style.cssText = buttonStyle();
    saveButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      savePosition('manual-button');
    });

    const restoreButton = document.createElement('button');
    restoreButton.type = 'button';
    restoreButton.textContent = t('restore');
    restoreButton.style.cssText = buttonStyle();
    restoreButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      restorePosition('manual-button');
    });

    const historyButton = document.createElement('button');
    historyButton.type = 'button';
    historyButton.textContent = t('history');
    historyButton.style.cssText = buttonStyle();
    historyButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleHistoryPanel();
    });

    box.appendChild(saveButton);
    box.appendChild(restoreButton);
    box.appendChild(historyButton);

    root.appendChild(status);
    root.appendChild(debug);
    root.appendChild(historyPanel);
    root.appendChild(box);

    document.documentElement.appendChild(root);

    state.ui.root = root;
    state.ui.status = status;
    state.ui.debug = debug;
    state.ui.historyPanel = historyPanel;

    if (state.settings.debug) {
      debug.style.display = 'block';
    }
  }

  function removeUI() {
    if (state.ui.root && state.ui.root.parentNode) {
      state.ui.root.parentNode.removeChild(state.ui.root);
    }

    state.ui = {
      root: null,
      status: null,
      debug: null,
      historyPanel: null
    };
  }

  function buttonStyle() {
    return [
      'border:1px solid rgba(83,100,113,.35)',
      'border-radius:999px',
      'background:rgba(255,255,255,.96)',
      'color:#0f1419',
      'padding:7px 10px',
      'font-weight:700',
      'box-shadow:0 4px 16px rgba(0,0,0,.18)',
      'cursor:pointer'
    ].join(';');
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

    window.addEventListener('popstate', () => {
      setTimeout(() => routeChanged('popstate'), 80);
    });
  }

  function routeChanged(reason) {
    if (state.url === location.href) return;

    const old = state.url;
    state.url = location.href;
    state.routeKey = getRouteKey();
    state.initialStarted = false;

    addLog('info', 'route:changed', {
      reason,
      old,
      next: state.url,
      routeKey: state.routeKey
    });

    clearTimeout(state.routeTimer);
    state.routeTimer = setTimeout(() => {
      restorePosition(`route-${reason}`, { silent: true });
    }, 500);
  }

  function observeRoute() {
    if (state.routeObserver) {
      state.routeObserver.disconnect();
    }

    state.routeObserver = new MutationObserver(() => {
      if (state.url !== location.href) {
        routeChanged('mutation');
      }

      ensureUI();
    });

    state.routeObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function listenCommands() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;

      if (changes[KEYS.SETTINGS]) {
        state.settings = {
          ...DEFAULT_SETTINGS,
          ...(changes[KEYS.SETTINGS].newValue || {})
        };

        addLog('info', 'settings:changed', state.settings);
        ensureUI();

        if (state.ui.debug) {
          state.ui.debug.style.display = state.settings.debug ? 'block' : 'none';
        }
      }

      if (changes[KEYS.COMMAND] && changes[KEYS.COMMAND].newValue) {
        const command = changes[KEYS.COMMAND].newValue;
        if (command.action === 'save') savePosition('popup-command');
        if (command.action === 'restore') restorePosition('popup-command');
      }
    });
  }

  async function loadSettings() {
    const data = await storageGet([KEYS.SETTINGS]);
    state.settings = {
      ...DEFAULT_SETTINGS,
      ...(data[KEYS.SETTINGS] || {})
    };
  }

  async function init() {
    await loadSettings();

    try {
      if ('scrollRestoration' in history) {
        history.scrollRestoration = 'manual';
      }
    } catch (_) {}

    state.routeKey = getRouteKey();

    patchHistory();
    observeRoute();
    listenCommands();
    ensureUI();

    window.addEventListener('scroll', () => {
      if (state.restoring) return;
      scheduleSave('scroll');
    }, { passive: true });

    window.addEventListener('wheel', () => markUserInput('wheel'), { passive: true, capture: true });
    window.addEventListener('touchstart', () => markUserInput('touchstart'), { passive: true, capture: true });
    window.addEventListener('keydown', () => markUserInput('keydown'), true);

    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const link = target ? target.closest('a[href*="/status/"]') : null;
      if (link && isSupportedRoute()) {
        savePosition('before-status-click');
      }
    }, true);

    await addLog('info', 'init', {
      routeKey: state.routeKey,
      articleCount: articles().length,
      settings: state.settings,
      scrollRestoration: history.scrollRestoration
    });

    fastInitialRestoreThenRefine();
  }

  init().catch((error) => {
    console.error(PREFIX, error);
  });
})();
