const STORAGE_KEYS = {
  SETTINGS: 'xfar_settings',
  POSITIONS: 'xfar_positions',
  HISTORY: 'xfar_history',
  LOGS: 'xfar_logs'
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

function get(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function set(data) {
  return new Promise((resolve) => chrome.storage.local.set(data, resolve));
}

function byId(id) {
  return document.getElementById(id);
}

function checkboxValue(id, fallback) {
  const el = byId(id);
  return el ? Boolean(el.checked) : fallback;
}

function numberValue(id, fallback) {
  const el = byId(id);
  if (!el) return fallback;
  const value = Number(el.value);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(5, Math.min(50, value));
}

function selectValue(id, fallback) {
  const el = byId(id);
  return el ? el.value : fallback;
}

function readForm() {
  return {
    autoRestore: checkboxValue('autoRestore', DEFAULT_SETTINGS.autoRestore),
    showButton: checkboxValue('showButton', DEFAULT_SETTINGS.showButton),
    enableHome: checkboxValue('enableHome', DEFAULT_SETTINGS.enableHome),
    enableSearch: checkboxValue('enableSearch', DEFAULT_SETTINGS.enableSearch),
    enableLists: checkboxValue('enableLists', DEFAULT_SETTINGS.enableLists),
    enableOtherTimelines: DEFAULT_SETTINGS.enableOtherTimelines,
    historyLimit: numberValue('historyLimit', DEFAULT_SETTINGS.historyLimit),
    debug: checkboxValue('debug', DEFAULT_SETTINGS.debug),
    language: selectValue('language', DEFAULT_SETTINGS.language)
  };
}

function writeForm(settings) {
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const checks = {
    autoRestore: merged.autoRestore,
    showButton: merged.showButton,
    enableHome: merged.enableHome,
    enableSearch: merged.enableSearch,
    enableLists: merged.enableLists,
    debug: merged.debug
  };
  for (const [id, value] of Object.entries(checks)) {
    const el = byId(id);
    if (el) el.checked = Boolean(value);
  }
  const historyLimit = byId('historyLimit');
  if (historyLimit) historyLimit.value = merged.historyLimit;
  const language = byId('language');
  if (language) language.value = merged.language;
}

function showStatus(message) {
  const status = byId('status');
  if (!status) return;
  status.textContent = message;
  setTimeout(() => { status.textContent = ''; }, 2200);
}

async function copyLogs() {
  const data = await get([STORAGE_KEYS.LOGS]);
  const logs = data[STORAGE_KEYS.LOGS] || [];
  const text = JSON.stringify(logs.slice(0, 80), null, 2);

  try {
    await navigator.clipboard.writeText(text);
    showStatus(`ログをコピーしました（${logs.length}件中${Math.min(logs.length, 80)}件）`);
  } catch (error) {
    console.error('[X Feed Anchor Restore] copy logs failed', error);
    showStatus('ログコピーに失敗しました。拡張ページの権限を確認してください');
  }
}

async function clearLogs() {
  await set({ [STORAGE_KEYS.LOGS]: [] });
  showStatus('ログをクリアしました');
}

async function clearPositions() {
  await set({
    [STORAGE_KEYS.POSITIONS]: {},
    [STORAGE_KEYS.HISTORY]: []
  });
  showStatus('保存位置と履歴をクリアしました');
}

async function init() {
  const data = await get([STORAGE_KEYS.SETTINGS]);
  const settings = { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.SETTINGS] || {}) };
  writeForm(settings);

  const save = byId('save');
  if (save) {
    save.addEventListener('click', async () => {
      const next = readForm();
      await set({ [STORAGE_KEYS.SETTINGS]: next });
      writeForm(next);
      showStatus('設定を保存しました');
    });
  }

  byId('copyLogs')?.addEventListener('click', copyLogs);
  byId('clearLogs')?.addEventListener('click', clearLogs);
  byId('clear')?.addEventListener('click', clearPositions);
}

init().catch((error) => {
  console.error('[X Feed Anchor Restore] popup error', error);
  showStatus('設定画面でエラーが発生しました');
});
