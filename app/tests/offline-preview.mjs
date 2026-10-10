import { makePngFixture } from '../../tests/png-metadata-fixtures.mjs';

// Fixture-only review wrapper. Neither this module nor the RPC bridge enters the APK.
export const previewHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NAI Pocket · 安卓体验预览</title>
<style>
.screen{box-sizing:content-box;max-width:calc(100% - 2px)}
*{box-sizing:border-box}body{margin:0;background:#edf1f5;color:#1c2b3c;font:15px/1.65 system-ui,sans-serif}main{display:grid;grid-template-columns:310px 1fr;min-height:100vh}aside{padding:28px 24px;background:#fff;border-right:1px solid #d9e1e8;overflow:auto;height:100vh}h1{font-size:24px;letter-spacing:-.6px;margin:0}h2{font-size:16px;margin:24px 0 8px}p{margin:8px 0}small,.muted{color:#617185}.badge{display:inline-block;background:#e5f4ec;color:#17653b;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700;margin-bottom:10px}.warning{border-left:3px solid #cf962b;padding-left:12px;margin-top:20px}button{font:inherit;border:1px solid #c9d5df;background:#fff;color:inherit;border-radius:8px;padding:7px 11px;cursor:pointer}button:hover{background:#edf4fa}button:disabled{opacity:.45;cursor:wait}button[aria-pressed=true]{background:#233e61;color:#fff;border-color:#233e61}.actions{display:flex;gap:7px;flex-wrap:wrap}section.stage{min-width:0;height:100vh;display:flex;align-items:center;flex-direction:column;padding:18px;gap:12px;overflow:auto}.screen{background:#fff;flex:1;width:min(100%,412px);min-height:300px;border:1px solid #bbc9d6;border-radius:16px;overflow:hidden;box-shadow:0 12px 42px #203e591a}iframe{display:block;border:0;width:100%;height:100%}.screen.narrow{width:min(100%,360px)}.screen.wide{width:min(100%,820px)}#status{font-size:13px;margin:0;min-height:22px}details{margin-top:12px}textarea{width:100%;height:56px;font:12px/1.5 monospace;resize:none;border:1px solid #d4dce4;border-radius:6px;padding:6px}ol{padding-left:22px}li{margin:8px 0}@media(max-width:740px){main{display:block}aside{height:auto;border:0;padding:18px}.stage{height:860px!important}.screen{flex:none;height:740px}aside h2{margin-top:16px}}
</style></head><body><main><aside><div class="badge">演示数据 · 不消耗额度</div><h1>NAI Pocket</h1><p class="muted">安卓界面体验预览</p><p>使用当前工作源码。界面、编辑与本地数据流程可操作；生成结果为占位图。</p><h2>先试这几步</h2><ol><li>在设置中切换官网 / RBQ，查看账号选择。</li><li>编辑提示词、添加角色，再点“生成”。</li><li>查看队列和图库，试试恢复参数和方案。</li><li>打开画师栏，搜索 anmi，查看三张合成例图及逐图标注。</li></ol><div class="actions"><button data-action="settings" disabled>账号设置</button><button data-action="editor" disabled>编辑器</button><button data-action="gallery" disabled>图库</button><button data-action="artists" disabled>画师</button></div><details><summary>需要练习添加 Token？</summary><p>只接受下方演示凭据，真实凭据会被拒绝。</p><label>官网演示 Token<textarea id="demoOfficial" readonly></textarea></label><label>RBQ 演示 Key<textarea id="demoRbq" readonly></textarea></label></details><div class="warning"><strong>三张例图与标注体验</strong><p>anmi 展示三张合成测试图，分别演示 AI 初标、人工确认与尚无标注。可试画风筛选、收藏和备注；真实资料包、下载及导入尚未接入。</p></div><h2>之后在手机确认</h2><p class="muted">系统键盘、安全区、Token 加密保存、文件导出、后台中断。浏览器预览不能证明这些已通过。</p><p class="muted">本次未打新 APK。预览数据仅用于本次体验。</p></aside><section class="stage"><div class="actions" aria-label="预览宽度"><button data-width="narrow" aria-pressed="false">窄屏 360</button><button data-width="phone" aria-pressed="true">手机 412</button><button data-width="wide" aria-pressed="false">宽屏 820</button></div><p id="status" role="status">正在准备演示账号和图库…</p><div class="screen"><iframe id="app" src="/app" title="NAI Pocket 安卓界面" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-popups"></iframe></div></section></main><script src="/fixture/review.js" defer></script></body></html>`;

export function previewHtmlForResources(review) {
  const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const kind=review.synthetic?'选定合成资料':'本地原作资料',names=review.names.slice(0,3).map(escape).join('、');
  return previewHtml.replace('演示数据 · 不消耗额度',`${kind} · 生成不消耗额度`)
    .replace('打开画师栏，搜索 anmi，查看三张合成例图及逐图标注。',`打开画师栏，搜索 ${names}，查看例图及对应标注。`)
    .replace(/<div class="warning">.*?<\/div>/,`<div class="warning"><strong>${kind}核对</strong><p>${escape(review.title)}</p><p>本地载入 ${review.artists} 位画师、${review.examples} 张例图，其中 ${review.annotatedExamples} 张有标注。图片来源、标注内容与 AI／人工状态沿用选定资料。</p><p>可核对三图、逐图标注、筛选、收藏和备注。此页面不联网下载；系统文件选择和下载仍需手机验收。生成和图库演示继续使用占位图。</p></div>`);
}

export const previewScript = `const frame=document.querySelector('#app'),status=document.querySelector('#status');
window.addEventListener('message',event=>{
  if(event.origin!==location.origin||event.source!==frame.contentWindow||event.data?.type!=='preview-ready')return;
  status.textContent=event.data.error||'可以开始体验 · 所有生成均为模拟';
  if(event.data.error)return;
  document.querySelector('#demoOfficial').value=event.data.token;
  document.querySelector('#demoRbq').value=event.data.rbqToken;
  document.querySelectorAll('[data-action]').forEach(button=>button.disabled=false);
});
document.querySelectorAll('[data-width]').forEach(button=>button.onclick=()=>{
  document.querySelector('.screen').className='screen '+button.dataset.width;
  document.querySelectorAll('[data-width]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
});
document.querySelectorAll('[data-action]').forEach(button=>button.onclick=()=>{
  const doc=frame.contentDocument;
  doc.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());
  const selector=button.dataset.action==='settings'?'#openSettingsButton':'[data-tab="'+button.dataset.action+'"]';
  doc.querySelector(selector)?.click();
});`;

export const previewSeedScript = `try {
  const deadline=Date.now()+20000;
  while(!globalThis.NAI_RUNTIME||document.querySelector('#appView').classList.contains('hidden')){
    if(Date.now()>deadline)throw new Error('预览初始化超时，请查看本地进程输出。');
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  const demo=await(await fetch('/fixture/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Fixture.claimSeed',args:{}})})).json();
  const call=async(url,body)=>{const response=await fetch(url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw new Error(data.error||data.message||'预览数据准备失败');return data;};
  if(demo.seed){
    const saved=await call('/api/providers/official/accounts',{name:'演示官网账号',token:demo.token});
    await call('/api/providers/official/accounts',{name:'备用演示账号',token:demo.secondToken});
    await call('/api/providers/rbq',{token:demo.rbqToken});
    const state={model:'nai-diffusion-4-5-full',prompt:'scenery, night sky, stars, blue sky',negativePrompt:'low quality',provider:'official',officialAccountId:saved.accountId,seed:42,seedMode:'fixed',params:{width:512,height:768,steps:20,scale:5}};
    await call('/api/schemes',{name:'体验用星空方案',data:state,isDefault:true});
    await call('/api/jobs/enqueue',{state,count:1});
    await call('/api/jobs/enqueue',{state:{...state,provider:'rbq',seed:43,params:{...state.params,width:768,height:512}},count:1});
    const deadline=Date.now()+20000;
    while(true){const jobs=(await call('/api/jobs')).jobs;if(jobs.some(job=>job.status==='failed'))throw new Error('演示图片准备失败');if(jobs.filter(job=>job.status==='completed').length===2)break;if(Date.now()>deadline)throw new Error('演示图片准备超时');await new Promise(resolve=>setTimeout(resolve,100));}
    location.reload();
  }else parent.postMessage({type:'preview-ready',token:demo.token,rbqToken:demo.rbqToken},location.origin);
}catch(error){parent.postMessage({type:'preview-ready',error:error.message},location.origin);}`;

export function previewImage(payload, sequence) {
  const width = Math.max(64, Math.min(1024, Number(payload.parameters?.width) || 512));
  const height = Math.max(64, Math.min(1024, Number(payload.parameters?.height) || 768));
  const rgba = Buffer.alloc(width * height * 4);
  for (let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const index=(y*width+x)*4, band=(Math.floor(x/64)+Math.floor(y/64))%2;
    const bright=((x*37+y*67+sequence*13)%1543)<3;
    rgba[index]=bright?230:25+Math.floor(65*y/height)+band*8;
    rgba[index+1]=bright?240:50+Math.floor(65*x/width)+band*8;
    rgba[index+2]=bright?255:100+(sequence%4)*25+band*8;
    rgba[index+3]=255;
  }
  return makePngFixture({width,height,rgba,entries:[{key:'Software',value:'NovelAI'},{key:'Comment',value:JSON.stringify({...payload.parameters,prompt:payload.input,description:'Synthetic UX preview; not model output'})}]});
}
