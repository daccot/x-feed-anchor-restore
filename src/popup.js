const STORAGE_KEYS = {
  SETTINGS: 'xfar_settings',
  POSITIONS: 'xfar_positions',
  HISTORY: 'xfar_history',
  LOGS: 'xfar_logs'
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

function get(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function set(data) {
  return new Promise((resolve) => chrome.storage.local.set(data, resolve));
}

function byId(id) {
  return document.getElementById(id);
}

function valueOfCheckbox(id, fallback) {
  const el = byId(id);
  return el ? el.checked : fallback;
}

function valueOfNumber(id, fallback) {
  const el = byId(id);
  const value = el ? Number(el.value) : fallback;
  return Number.isFinite(value) ? Math.max(5, Math.min(value, 50)) : fallback;
}

function valueOfSelect(id, fallback) {
  const el = byId(id);
  return el ? el.value : fallback;
}

function readForm() {
  return {
    autoRestore: valueOfCheckbox('autoRestore', DEFAULT_SETTINGS.autoRestore),
    showButton: valueOfCheckbox('showButton', DEFAULT_SETTINGS.showButton),
    enableHome: valueOfCheckbox('enableHome', DEFAULT_SETTINGS.enableHome),
    enableSearch: valueOfCheckbox('enableSearch', DEFAULT_SETTINGS.enableSearch),
    enableLists: valueOfCheckbox('enableLists', DEFAULT_SETTINGS.enableLists),
    enableOtherTimelines: DEFAULT_SETTINGS.enableOtherTimelines,
    historyLimit: valueOfNumber('historyLimit', DEFAULT_SETTINGS.historyLimit),
    debug: valueOfCheckbox('debug', DEFAULT_SETTINGS.debug),
    language: valueOfSelect('language', DEFAULT_SETTINGS.language)
  };
}

function writeForm(settings) {
  const map = {
    autoRestore: settings.autoRestore,
    showButton: settings.showButton,
    enableHome: settings.enableHome,
    enableSearch: settings.enableSearch,
    enableLists: settings.enableLists,
    debug: settings.debug
  };
  for (const [id, value] of Object.entries(map)) {
    const el = byId(id);
    if (el) el.checked = Boolean(value);
  }
  const historyLimit = byId('historyLimit');
  if (historyLimit) historyLimit.value = settings.historyLimit;
  const language = byId('language');
  if (language) language.value = settings.language;
}

function showStatus(message) {
  let status = byId('status');
  if (!status) {
    status = document.createElement('p');
    status.id = 'status';
    status.style.marginTop = '12px';
    status.style.color = '#1d9bf0';
    document.body.appendChild(status);
  }
  status.textContent = message;
  setTimeout(() => { status.textContent = ''; }, 1800);
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
      showStatus('設定を保存しました');
    });
  }

  const clear = byId('clear');
  if (clear) {
    clear.addEventListener('click', async () => {
      await set({
        [STORAGE_KEYS.POSITIONS]: {},
        [STORAGE_KEYS.HISTORY]: [],
        [STORAGE_KEYS.LOGS]: []
      });
      showStatus('保存位置とログをクリアしました');
    });
  }
}

init().catch((error) => {
  console.error('[X Feed Anchor Restore] popup error', error);
  showStatus('設定画面でエラーが発生しました');
});
