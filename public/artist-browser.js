import { buildNaxV5ArtistSearchUrl, normalizeArtistIdentity } from './artist-index-v5.js?v=1.6.81';
import { STYLE_ATTRIBUTES, describeStyleAttributes, observationAttributes } from './artist-style-schema.js?v=1.6.81';

const node=(tag,text='',className='')=>{const result=document.createElement(tag);result.textContent=text;if(className)result.className=className;return result;};
const button=(text,action,className='')=>{const result=node('button',text,className);result.type='button';result.addEventListener('click',action);return result;};

// The public reader displays prepared annotations; collection/editing workers stay private.

export function createArtistBrowser({api,mount,toast=()=>{},addArtist=()=>{},previewArtist=()=>{},onNavigate=()=>{}}) {
  let root,list,detail,search,favorites,summary,status,grid,pager,loadImages,resourceStatus,importStatus,resourceProgress,resourceCancel;
  let page=1,onlyFavorites=false,loaded=false,selected='',dirty=false,query='',scroll=0,revision=0,detailRevision=0;
  let controller=null,searchTimer=null,current=[],bytes=0,detailBytes=0,confirmedOnly=false,attributes={};
  let resourceBusy=false,resourceRevision=0,cancelling=false;
  let catalog=null,catalogRows,catalogSummary,catalogSearch,catalogUrl,resourceDownload,installedSets=[];
  let defaultCatalogUrl='',catalogAttemptedUrl='',catalogUrlEdited=false;
  const images=new Map(),detailImages=new Map(),drafts=new Map();
  const notify=error=>toast(error.message||String(error),'error');
  const scrollToStart=target=>window.scrollTo({top:Math.max(0,window.scrollY+target.getBoundingClientRect().top-(document.querySelector('.workspace-topbar')?.getBoundingClientRect().height||0)-12)});
  const releaseImages=()=>{for(const item of images.values()){item.controller.abort();if(item.url)URL.revokeObjectURL(item.url);}images.clear();bytes=0;};
  const releaseDetail=()=>{for(const item of detailImages.values()){item.controller.abort();if(item.url)URL.revokeObjectURL(item.url);}detailImages.clear();detailBytes=0;};
  function busy(control,work){control.disabled=true;return Promise.resolve().then(work).catch(notify).finally(()=>{if(control.isConnected)control.disabled=false;});}
  function markFavorite(control,profile){control.textContent=profile.favorite?'★':'☆';control.setAttribute('aria-label',`${profile.favorite?'取消收藏':'收藏'} ${profile.artist}`);control.setAttribute('aria-pressed',String(profile.favorite));}
  function favoriteButton(profile,after=()=>{}) {
    const control=button('',()=>busy(control,async()=>{
      const {artist}=await api('/api/artists/profile',{method:'PUT',body:{artist:profile.artist,favorite:!profile.favorite}});
      Object.assign(profile,artist);markFavorite(control,profile);dirty=true;after(profile);
    }),'artist-browser-favorite');
    markFavorite(control,profile);return control;
  }
  function add(profile){addArtist(profile.artist);}
  async function findResources(artist) {
    await returnToList();
    catalogSearch.value=artist;
    if(catalog)renderCatalog();
    else catalogSummary.textContent=`先读取资料目录，再查找“${artist}”所在的资料包。`;
    resourceDownload.open=true;onNavigate();scrollToStart(resourceDownload);
    (catalog?catalogSearch:catalogUrl).focus({preventScroll:true});
    await offerCatalog();
  }
  function offerCatalog() {
    const url=catalogUrl?.value.trim();
    // Opening download controls is the user's request to read the small index.
    // A failed read is retried by the explicit button, never an automatic loop.
    if(!defaultCatalogUrl||!url||catalog||resourceBusy||catalogAttemptedUrl===url)return;
    return runResource('catalog',{url});
  }
  function resourceControls() {
    root?.querySelectorAll('[data-resource-start]').forEach(control=>{control.disabled=resourceBusy||control.dataset.resourceInstalled==='true';});
    if(resourceProgress)resourceProgress.hidden=!resourceBusy;
    if(resourceCancel)resourceCancel.hidden=!resourceBusy;
  }
  function renderCatalog() {
    if(!catalogRows||!catalog)return;
    const needle=normalizeArtistIdentity(catalogSearch.value),installed=new Map(installedSets.map(row=>[row.id,row.version]));
    catalogSummary.textContent=`${catalog.synthetic?'合成演示资料 · ':''}${catalog.title} · ${catalog.version} · ${catalog.artists.toLocaleString()} 位画师 · ${catalog.examples.toLocaleString()} 张原作，其中 ${catalog.annotatedExamples.toLocaleString()} 张有标注。AI 初标 ${catalog.aiInitialObservations.toLocaleString()} 条；${catalog.artistsByExampleCount[0]} 位画师暂无原作。`;
    catalogRows.replaceChildren();
    const rows=catalog.shards.filter(row=>!needle||row.artistNames.some(name=>normalizeArtistIdentity(name).includes(needle)));
    if(!rows.length){catalogRows.append(node('p','没有包含该画师的资料包。'));return;}
    for(const row of rows) {
      const card=node('article','','artist-pack-card');card.dataset.packId=row.id;
      const version=installed.get(row.id),same=version===row.version;
      const names=(needle?row.artistNames.filter(name=>normalizeArtistIdentity(name).includes(needle)):row.artistNames).slice(0,4);
      const start=button(same?'已安装此版本':version?'下载此版本':'下载并安装此包',()=>runResource('download',{
        url:row.url,sha256:row.sha256,expectedId:row.id,expectedVersion:row.version
      }));start.dataset.resourceStart='';start.dataset.resourceInstalled=String(same);
      card.append(node('strong',`${row.id} · ${(row.bytes/1024/1024).toFixed(1)} MiB`),
        node('p',`${row.artists} 位画师 · ${row.examples} 张原作 · ${row.annotatedExamples} 张有标注`),
        node('p',names.join('、')+(row.artistNames.length>names.length?' 等':''),'artist-browser-hint'),
        node('small',version?`本机已安装版本：${version}`:'尚未安装'),start);catalogRows.append(card);
    }
    resourceControls();
  }
  async function cancelResource() {
    if(!resourceBusy)return;
    const operation=resourceRevision;resourceCancel.disabled=true;
    try {
      const result=await api('/api/artists/resources/cancel',{method:'POST'});
      if(operation!==resourceRevision||!resourceBusy)return;
      cancelling=result.accepted;
      importStatus.textContent=result.accepted?'正在取消…':'正在安装资料，请等待完成。';
    }catch(error){if(operation===resourceRevision&&resourceBusy)notify(error);}
    // Polling owns availability; an old acknowledgement cannot enable a newer operation's button.
  }
  async function runResource(kind,body) {
    if(resourceBusy)return;
    if(kind==='catalog')catalogAttemptedUrl=body?.url||'';
    resourceBusy=true;cancelling=false;const operation=++resourceRevision;resourceControls();
    resourceCancel.disabled=true;resourceProgress.removeAttribute('value');
    importStatus.textContent=kind==='catalog'?'正在读取资料目录…':kind==='download'?'正在连接资料包下载…':'正在选择、校验并安装资料包…';
    const poll=async()=>{
      try {
        const state=await api('/api/artists/resources/status');
        if(operation!==resourceRevision||!resourceBusy||!state.busy)return;
        resourceCancel.disabled=!state.cancellable||cancelling;
        if(cancelling){importStatus.textContent='正在取消…';return;}
        const received=Math.max(0,Number(state.receivedBytes)||0),total=Math.max(0,Number(state.totalBytes)||0);
        if(state.phase==='download'&&total){resourceProgress.value=Math.min(1,received/total);}
        else resourceProgress.removeAttribute('value');
        const size=(received/1024/1024).toFixed(1);
        importStatus.textContent=state.phase==='catalog'?'正在读取资料目录…':state.phase==='download'?`正在下载 ${size}${total?' / '+(total/1024/1024).toFixed(1):''} MB`
          :state.phase==='verify'?`正在校验例图（已读取 ${size} MB）…`
          :state.phase==='install'?'正在安装资料，请保持应用在前台…':'请选择资料包文件…';
      }catch{/* The operation's response owns failures; a status poll must not cancel it. */}
    };
    const timer=setInterval(poll,500);
    try {
      const result=await api(`/api/artists/resources/${kind}`,{method:'POST',...(body?{body}:{})});
      if(result.cancelled){importStatus.textContent=kind==='catalog'?'已取消读取目录。':kind==='download'?'已取消下载，原有资料保持不变。':'已取消导入。';return;}
      if(kind==='catalog') {
        catalog=result.catalog;catalogSearch.hidden=false;renderCatalog();
        try{localStorage.setItem('nai-artist-resource-catalog-url',catalog.url);}catch{}
        importStatus.textContent=`已读取 ${catalog.shards.length} 个资料包。可按画师名查找并选择下载。`;return;
      }
      await loadList();window.dispatchEvent(new Event('nai-artist-resources-changed'));
      importStatus.textContent=`已安装 ${result.artists} 位画师的 ${result.examples} 张例图及对应标注。`;
    }catch(error){importStatus.textContent=kind==='catalog'?'目录读取失败，原有目录和本机资料保持不变。':'资料包未安装，原有资料保持不变。';notify(error);}
    finally{clearInterval(timer);resourceRevision++;resourceBusy=false;resourceControls();}
  }
  function ensure() {
    if(root)return;
    root=node('div','','artist-browser');
    list=node('div');detail=node('div');detail.hidden=true;
    const header=node('header','','artist-browser-header');header.append(node('h1','画师'),node('span','原作例图 · 逐图标注','artist-browser-source'));
    resourceStatus=node('p','','artist-browser-resource-status');resourceStatus.setAttribute('role','status');
    importStatus=node('p','','artist-browser-status');importStatus.setAttribute('role','status');
    resourceProgress=node('progress');resourceProgress.max=1;resourceProgress.hidden=!resourceBusy;resourceProgress.setAttribute('aria-label','资料包处理进度');
    resourceCancel=button('取消资料包操作',cancelResource);resourceCancel.hidden=!resourceBusy;
    const hint=node('p','已下载的例图与标注可离线查看。收藏和本机备注单独保存。','artist-browser-hint');
    search=node('input');search.type='search';search.placeholder='搜索画师名、别名或本机备注';search.setAttribute('aria-label','搜索画师');
    search.addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{query=search.value;page=1;loadList();},200);});
    const filters=node('div','','artist-browser-filters');
    favorites=button('只看收藏',()=>{onlyFavorites=!onlyFavorites;favorites.setAttribute('aria-pressed',String(onlyFavorites));page=1;loadList();});favorites.setAttribute('aria-pressed','false');
    loadImages=button('载入本页例图',()=>loadPageImages());
    const importPack=button('导入资料包',()=>runResource('import'));importPack.dataset.resourceStart='';importPack.disabled=resourceBusy;
    filters.append(favorites,loadImages,importPack);
    const download=resourceDownload=node('details','','artist-pack-download');download.append(node('summary','从 GitHub 下载资料包'));
    download.addEventListener('toggle',()=>{if(download.open)offerCatalog();});
    catalogUrl=node('input');catalogUrl.type='url';catalogUrl.maxLength=2048;catalogUrl.placeholder='粘贴 Release 中 catalog.json 的下载链接';catalogUrl.setAttribute('aria-label','资料目录链接');catalogUrl.dataset.resourceStart='';
    try{catalogUrl.value=localStorage.getItem('nai-artist-resource-catalog-url')||'';}catch{}
    catalogUrl.addEventListener('input',()=>{catalogUrlEdited=true;});
    const readCatalog=button('读取资料目录',()=>runResource('catalog',{url:catalogUrl.value.trim()}));readCatalog.dataset.resourceStart='';
    catalogSummary=node('p','','artist-browser-hint');catalogSummary.setAttribute('role','status');
    catalogSearch=node('input');catalogSearch.type='search';catalogSearch.placeholder='搜索画师，找到所在资料包';catalogSearch.setAttribute('aria-label','查找画师资料包');catalogSearch.hidden=true;catalogSearch.addEventListener('input',renderCatalog);
    catalogRows=node('div','','artist-pack-catalog');
    download.append(catalogUrl,readCatalog,catalogSummary,catalogSearch,catalogRows);
    const direct=node('details');direct.append(node('summary','已有单个 ZIP 下载链接'));
    const url=node('input');url.type='url';url.maxLength=2048;url.placeholder='粘贴 Release 资料包的 ZIP 下载链接';url.setAttribute('aria-label','资料包下载链接');
    const start=button('下载并安装',()=>runResource('download',{url:url.value.trim()}));start.dataset.resourceStart='';start.disabled=resourceBusy;
    direct.append(url,start);download.append(node('p','无需填写 Token。选择需要的资料包，下载后可离线查看；请保持应用在前台。','artist-browser-hint'),direct);
    const styleFilters=node('details','','artist-browser-style-filters');styleFilters.append(node('summary','按标注筛选'));
    const selectors=node('div','','artist-browser-filters'),dimension=node('select'),value=node('select'),chips=node('div','','artist-browser-chips');
    dimension.setAttribute('aria-label','筛选维度');value.setAttribute('aria-label','筛选特征');
    for(const item of STYLE_ATTRIBUTES){const option=node('option',item.label);option.value=item.key;dimension.append(option);}
    function choices(){value.replaceChildren();for(const item of STYLE_ATTRIBUTES.find(item=>item.key===dimension.value).options){const option=node('option',item.label);option.value=item.value;value.append(option);}}
    const renderChips=()=>{chips.replaceChildren();for(const item of describeStyleAttributes(attributes))chips.append(button(`${item.label} ×`,()=>{attributes[item.key]=attributes[item.key].filter(value=>value!==item.value);if(!attributes[item.key].length)delete attributes[item.key];renderChips();page=1;loadList();}));};
    dimension.addEventListener('change',choices);choices();
    const addFilter=button('添加条件',()=>{attributes[dimension.value]=[...new Set([...(attributes[dimension.value]||[]),value.value])];renderChips();page=1;loadList();});
    const confirmed=button('仅人工确认',()=>{confirmedOnly=!confirmedOnly;confirmed.setAttribute('aria-pressed',String(confirmedOnly));page=1;loadList();});confirmed.setAttribute('aria-pressed','false');
    selectors.append(dimension,value,addFilter,confirmed);styleFilters.append(selectors,chips,node('p','默认包含 AI 初标；不同维度须在同一张例图的标注中同时满足，同一维度任选其一。','artist-browser-hint'));
    summary=node('p','','artist-browser-summary');status=node('p','','artist-browser-status');status.setAttribute('role','status');
    grid=node('div','','artist-browser-grid');pager=node('nav','','artist-browser-pages');pager.setAttribute('aria-label','画师分页');
    list.append(header,resourceStatus,hint,search,filters,download,importStatus,resourceProgress,resourceCancel,styleFilters,summary,status,grid,pager);root.append(list,detail);mount.append(root);
  }
  async function loadList() {
    ensure();const request=++revision;controller?.abort();controller=new AbortController();releaseImages();
    status.textContent='正在读取画师…';grid.setAttribute('aria-busy','true');
    try {
      const params=new URLSearchParams({q:query,page:String(page),limit:'24',favorite:onlyFavorites?'1':'0',confirmed:confirmedOnly?'1':'0',attributes:JSON.stringify(attributes)});
      const result=await api(`/api/artists?${params}`,{signal:controller.signal});
      if(request!==revision)return;
      current=result.artists;page=result.page;loaded=true;dirty=false;
      installedSets=result.resources?.sets||[];renderCatalog();
      defaultCatalogUrl=result.resources?.defaultCatalogUrl||'';
      if(defaultCatalogUrl&&!catalogUrlEdited&&!catalogUrl.value.trim())catalogUrl.value=defaultCatalogUrl;
      if(resourceDownload.open)offerCatalog();
      resourceStatus.textContent=result.resources?.installed
        ? `${result.resources.sets.some(set=>set.synthetic)?'合成演示资料 · ':''}本机有 ${result.resources.artists.toLocaleString()} 位画师的资料。图片是否可用以实际读取为准。`
        : '尚未安装画师资料包，当前仅可浏览名称和个人记录；原作例图与标注暂不可用。';
      summary.textContent=`${result.total.toLocaleString()} 位${onlyFavorites?'收藏画师':'画师'} · 已收藏 ${result.favorites.toLocaleString()} 位`;
      status.textContent=result.total?'':'没有匹配的画师。';grid.replaceChildren();pager.replaceChildren();
      for(const profile of current){
        const card=node('article','','artist-browser-card');card.dataset.artist=profile.artist;
        const heading=node('div','','artist-browser-card-head');const name=button(profile.artist,()=>open(profile.artist),'artist-browser-name');
        heading.append(name,favoriteButton(profile,()=>{if(onlyFavorites)loadList();else summary.textContent='收藏已更新，保存在本机。';}));
        const image=button(profile.coverUrl?'载入原作例图':'尚无原作例图',()=>profile.coverUrl?loadCardImage(profile,card,request):open(profile.artist),'artist-browser-image');
        image.setAttribute('aria-label',`${profile.artist} 的例图`);
        const actions=node('div','','artist-browser-card-actions');actions.append(button('加入画风',()=>add(profile)),button('资料',()=>open(profile.artist)));
        card.append(image,heading,node('small',profile.exampleCount?`${profile.exampleCount} 张例图 · ${profile.annotatedCount} 张有标注`:'原作资料未收录'),actions);grid.append(card);
      }
      const previous=button('上一页',()=>{page--;loadList().then(()=>scrollToStart(root));});previous.disabled=page<=1;
      const next=button('下一页',()=>{page++;loadList().then(()=>scrollToStart(root));});next.disabled=page>=result.pages;
      pager.append(previous,node('span',`${page} / ${result.pages}`),next);loadImages.disabled=!current.some(item=>item.coverUrl);loadImages.textContent='载入本页例图';
    } catch(error) {
      if(request!==revision||error.name==='AbortError')return;
      status.textContent=`读取失败：${error.message}`;const retry=button('重试',loadList);grid.replaceChildren(retry);
    } finally {if(request===revision)grid.removeAttribute('aria-busy');}
  }
  async function loadCardImage(profile,card,request) {
    if(request!==revision||!card.isConnected)return;
    const control=card.querySelector('.artist-browser-image');
    if(images.has(profile.artist)){if(images.get(profile.artist).url)open(profile.artist);return;}
    const resource={controller:new AbortController(),url:''};images.set(profile.artist,resource);control.disabled=true;control.textContent='载入中…';
    try {
      const response=await fetch(profile.coverUrl,{signal:resource.controller.signal});
      if(!response.ok)throw new Error((await response.json()).error||'例图不可用');
      const blob=await response.blob();
      if(request!==revision||images.get(profile.artist)!==resource)return;
      if(blob.size>4*1024*1024||bytes+blob.size>16*1024*1024)throw new Error('本页图片较大，请在画师详情中单独查看。');
      bytes+=blob.size;resource.url=URL.createObjectURL(blob);const img=node('img');img.src=resource.url;img.alt=`${profile.artist} 的原作例图`;
      img.addEventListener('error',()=>{control.textContent='图片解码失败，点此重试';if(images.get(profile.artist)===resource){images.delete(profile.artist);bytes-=blob.size;URL.revokeObjectURL(resource.url);}},{once:true});
      control.replaceChildren(img);
    } catch(error) {
      if(request!==revision||resource.controller.signal.aborted)return;
      images.delete(profile.artist);control.textContent='暂不可用，点此重试';control.title=error.message;
    } finally {if(request===revision)control.disabled=false;}
  }
  async function loadPageImages() {
    const request=revision,items=current.filter(item=>item.coverUrl);let index=0;
    loadImages.disabled=true;loadImages.textContent='正在载入例图…';
    const worker=async()=>{while(index<items.length&&request===revision){const item=items[index++];const card=[...grid.children].find(card=>card.dataset.artist===item.artist);if(card&&!images.has(item.artist))await loadCardImage(item,card,request);}};
    await Promise.all([worker(),worker()]);
    if(request===revision){loadImages.disabled=false;loadImages.textContent='重试未载入的例图';}
  }
  async function open(value='') {
    ensure();if(!value){onNavigate();return returnToList();}
    releaseDetail();
    if(!selected&&mount.closest('.tab-panel')?.classList.contains('active'))scroll=window.scrollY;
    selected=value;const request=++detailRevision;
    list.hidden=true;detail.hidden=false;detail.replaceChildren(node('p','正在读取画师资料…'));onNavigate();
    try {
      const {artist:profile}=await api(`/api/artists/profile?artist=${encodeURIComponent(value)}`);
      if(request!==detailRevision)return;
      const back=button('‹ 返回画师列表',returnToList);
      const header=node('div','','artist-browser-detail-head');header.append(node('h2',profile.artist),favoriteButton(profile));
      const source=node('p',profile.resourceSet
        ? `${profile.resourceSet.synthetic?'合成演示，不是画师原作。 ':''}${profile.resourceSet.title} · ${profile.resourceSet.version} · ${profile.exampleCount} 张例图，${profile.annotatedCount} 张有标注，${profile.reviewedCount} 张人工确认。`
        : '这位画师的原作资料尚未收录到本机。','artist-browser-hint');
      const actions=node('div','','artist-browser-detail-actions');actions.append(button('加入画风',()=>add(profile),'primary'));
      actions.append(button('查找资料包',()=>findResources(profile.artist).catch(notify)));
      if(profile.indexed)actions.append(button('查看 NAX 例图',()=>previewArtist(profile.artist)));
      if(profile.indexed){const link=node('a','NAX 参考 ↗');link.href=buildNaxV5ArtistSearchUrl(profile.artist);link.target='_blank';link.rel='noopener noreferrer';actions.append(link);}
      const examples=renderExamples(profile);
      const key=normalizeArtistIdentity(profile.artist);
      let draft=drafts.get(key);
      if(!draft){draft={value:profile.note,baseline:profile.note};drafts.set(key,draft);}
      else if(draft.value===draft.baseline){draft.value=profile.note;draft.baseline=profile.note;}
      const label=node('label','本机备注');const note=node('textarea');note.value=draft.value;note.rows=5;note.maxLength=2000;note.setAttribute('aria-label','画师备注');label.append(note);
      const draftHint=node('p','修改后请点保存；草稿仅保留在本次打开期间。','artist-browser-hint');
      const saved=node('p','','artist-browser-status');saved.setAttribute('role','status');
      draft.render=message=>{if(request===detailRevision)saved.textContent=draft.value!==draft.baseline?'有未保存的修改。':message||'';};
      note.addEventListener('input',()=>{draft.value=note.value;draft.render();});draft.render();
      const save=button('保存备注',()=>busy(save,async()=>{
        const value=draft.value;
        await api('/api/artists/profile',{method:'PUT',body:{artist:profile.artist,note:value}});
        dirty=true;draft.baseline=value;draft.render('备注已保存在本机。');
      }));
      detail.replaceChildren(back,header,source,actions,examples,label,draftHint,save,saved);
      scrollToStart(detail);
      loadDetailImages(profile,examples,request);
    }catch(error){if(request!==detailRevision)return;detail.replaceChildren(button('‹ 返回画师列表',returnToList),node('p',`读取失败：${error.message}`),button('重试',()=>open(value)));}
  }
  function renderExamples(profile) {
    const section=node('section','','artist-example-reader');section.setAttribute('aria-label','原作例图与标注');
    section.append(node('h3','原作例图与逐图标注'));
    if(profile.examples.length!==3)section.append(node('p',profile.examples.length?`当前资料有 ${profile.examples.length} 张原作例图。`:'暂无原作例图与标注。','artist-browser-hint'));
    const cards=node('div','','artist-example-grid');
    profile.examples.forEach((example,index)=>{
      const card=node('article','','artist-example-card');card.dataset.exampleId=example.id;
      card.append(node('h4',`例图 ${index+1}`));
      const media=node('div','正在读取本机例图…','artist-example-media');media.setAttribute('role','status');card.append(media);
      const observations=profile.observations.filter(item=>item.exampleId===example.id);
      if(!observations.length)card.append(node('p','尚无标注','artist-example-badge'));
      for(const item of observations){
        const annotation=node('div','','artist-example-observation');annotation.dataset.observationId=item.id;
        annotation.append(node('p',item.reviewed?'人工已确认':item.automatic?'AI 初标 · 未人工确认':'未确认标注','artist-example-badge'));
        const labels=node('div','','artist-example-labels');
        for(const attribute of describeStyleAttributes(observationAttributes(item)))labels.append(node('span',attribute.label));
        annotation.append(labels,node('p',item.note||'没有文字说明。','artist-example-note'));
        const provenance=node('details','','artist-example-provenance');provenance.append(node('summary','标注来源'),node('p',`来源：${item.source} · 标注版本：${item.schemaVersion}`));
        if(Object.keys(item.provenance||{}).length)provenance.append(node('pre',JSON.stringify(item.provenance,null,2)));
        annotation.append(provenance);card.append(annotation);
      }
      if(example.note)card.append(node('p',example.note,'artist-browser-hint'));
      if(example.sourceUrl){const source=node('a','原作来源 ↗');source.href=example.sourceUrl;source.target='_blank';source.rel='noopener noreferrer';card.append(source);}
      cards.append(card);
    });
    section.append(cards,node('p','标注描述对应作品的可见特征，不代表生成模型对该画师的还原效果。','artist-browser-hint'));
    return section;
  }
  async function loadDetailImages(profile,section,request) {
    let index=0;
    const worker=async()=>{while(index<profile.examples.length&&request===detailRevision){
      const position=index++,example=profile.examples[position],media=section.querySelectorAll('.artist-example-media')[position];
      const resource={controller:new AbortController(),url:''};detailImages.set(example.id,resource);
      try {
        const response=await fetch(example.previewUrl,{signal:resource.controller.signal});
        if(!response.ok)throw new Error((await response.json()).error||'例图不可用。');
        const blob=await response.blob();
        if(request!==detailRevision||resource.controller.signal.aborted)return;
        if(blob.size>4*1024*1024||detailBytes+blob.size>16*1024*1024)throw new Error('例图较大，已达到本页读取上限。');
        detailBytes+=blob.size;
        resource.url=URL.createObjectURL(blob);const image=node('img');image.src=resource.url;image.alt=`${profile.artist} 例图 ${position+1}`;
        image.addEventListener('error',()=>{if(request===detailRevision){media.replaceChildren(node('p','例图无法解码。'));URL.revokeObjectURL(resource.url);resource.url='';detailBytes-=blob.size;}},{once:true});
        media.replaceChildren(image);
      } catch(error) {
        if(request!==detailRevision||resource.controller.signal.aborted)return;
        media.replaceChildren(node('p',error.message));
      }
    }};
    await Promise.all([worker(),worker()]);
  }
  async function returnToList(){selected='';detailRevision++;releaseDetail();detail.hidden=true;list.hidden=false;if(!loaded||dirty)await loadList();window.scrollTo({top:scroll});}
  async function show(){ensure();if(!selected&&(!loaded||dirty))await loadList();}
  function back(){if(!selected)return false;returnToList().catch(notify);return true;}
  function reset(){revision++;detailRevision++;controller?.abort();clearTimeout(searchTimer);releaseImages();releaseDetail();drafts.clear();root?.remove();root=null;loaded=false;selected='';query='';page=1;onlyFavorites=false;dirty=false;confirmedOnly=false;attributes={};}
  return {show,open,back,reset,refresh:async()=>{dirty=true;if(root&&!selected&&mount.closest('.tab-panel')?.classList.contains('active'))await loadList();}};
}
