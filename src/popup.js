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

function showStatus(message) {
  const status = byId('status');
  if (!status) return;
  status.textContent = message;
  setTimeout(() => { status.textContent = ''; }, 2000);
}

async function copyLogs() {
  const data = await get([STORAGE_KEYS.LOGS]);
  const logs = data[STORAGE_KEYS.LOGS] || [];
  const text = JSON.stringify(logs.slice(0, 50), null, 2);
  await navigator.clipboard.writeText(text);
  showStatus('ログをコピーしました');
}

async function clearLogs() {
  await set({ [STORAGE_KEYS.LOGS]: [] });
  showStatus('ログをクリアしました');
}

async function init() {
  const save = byId('save');
  if (save) {
    save.addEventListener('click', async () => {
      const settings = DEFAULT_SETTINGS;
      await set({ [STORAGE_KEYS.SETTINGS]: settings });
      showStatus('設定を保存しました');
    });
  }

  byId('copyLogs')?.addEventListener('click', copyLogs);
  byId('clearLogs')?.addEventListener('click', clearLogs);
}

init();
