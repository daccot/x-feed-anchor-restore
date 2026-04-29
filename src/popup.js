const STORAGE_KEYS = {
  SETTINGS: 'xfar_settings',
  POSITIONS: 'xfar_positions',
  HISTORY: 'xfar_history'
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

function get(keys){return new Promise(r=>chrome.storage.local.get(keys,r));}
function set(d){return new Promise(r=>chrome.storage.local.set(d,r));}

function byId(id){return document.getElementById(id);}

function readForm(){
  return {
    autoRestore: byId('autoRestore').checked,
    showButton: byId('showButton').checked,
    enableHome: byId('enableHome').checked,
    enableSearch: byId('enableSearch').checked,
    enableLists: byId('enableLists').checked,
    enableOtherTimelines: byId('enableOtherTimelines').checked,
    historyLimit: Number(byId('historyLimit').value)||10,
    debug: byId('debug').checked,
    language: byId('language').value
  };
}

function writeForm(s){
  byId('autoRestore').checked=s.autoRestore;
  byId('showButton').checked=s.showButton;
  byId('enableHome').checked=s.enableHome;
  byId('enableSearch').checked=s.enableSearch;
  byId('enableLists').checked=s.enableLists;
  byId('enableOtherTimelines').checked=s.enableOtherTimelines;
  byId('historyLimit').value=s.historyLimit;
  byId('debug').checked=s.debug;
  byId('language').value=s.language;
}

async function init(){
  const data=await get([STORAGE_KEYS.SETTINGS]);
  const s={...DEFAULT_SETTINGS,...(data[STORAGE_KEYS.SETTINGS]||{})};
  writeForm(s);

  byId('save').onclick=async()=>{
    const next=readForm();
    await set({[STORAGE_KEYS.SETTINGS]:next});
  };

  byId('clear').onclick=async()=>{
    await set({[STORAGE_KEYS.POSITIONS]:{},[STORAGE_KEYS.HISTORY]:[]});
  };
}

init();
