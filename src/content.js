// X Feed Anchor Restore - core logic
(function(){
  const PREFIX='[X Feed Anchor Restore]';
  const STORAGE_KEY='xFeedPositions';

  const qs=(s)=>Array.from(document.querySelectorAll(s));

  function getArticles(){
    return qs('article[data-testid="tweet"], div[data-testid="cellInnerDiv"] article');
  }

  function extractId(article){
    const a=article.querySelector('a[href*="/status/"]');
    if(!a) return null;
    const m=a.href.match(/status\/(\d+)/);
    return m?m[1]:null;
  }

  function getAnchor(){
    const arts=getArticles();
    let best=null,dist=Infinity;
    arts.forEach(a=>{
      const r=a.getBoundingClientRect();
      if(r.bottom<0) return;
      const d=Math.abs(r.top);
      if(d<dist){
        const id=extractId(a);
        if(id){dist=d;best={id,offset:r.top}};
      }
    });
    return best;
  }

  function save(){
    const a=getAnchor();
    if(!a) return;
    chrome.storage.local.get(STORAGE_KEY, data=>{
      const arr=data[STORAGE_KEY]||[];
      arr.unshift({id:a.id,offset:a.offset,t:Date.now(),url:location.href});
      chrome.storage.local.set({[STORAGE_KEY]:arr.slice(0,10)});
    });
  }

  let t;
  window.addEventListener('scroll',()=>{
    clearTimeout(t);
    t=setTimeout(save,500);
  },{passive:true});

  function restore(){
    chrome.storage.local.get(STORAGE_KEY,data=>{
      const arr=data[STORAGE_KEY];
      if(!arr||!arr.length) return;
      const target=arr[0];
      const iv=setInterval(()=>{
        const el=document.querySelector(`a[href*="/status/${target.id}"]`);
        if(el){
          clearInterval(iv);
          const art=el.closest('article');
          if(art){
            art.scrollIntoView();
            requestAnimationFrame(()=>window.scrollBy(0,target.offset));
          }
        }
      },300);
      setTimeout(()=>clearInterval(iv),10000);
    });
  }

  window.addEventListener('load',restore);
})();
