// Synthetic native bridge, real browser UI/Canvas and real isolated SQLite/files.
// This validates app wiring; Android Keystore/foreground execution need a device.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { makePngFixture } from '../../tests/png-metadata-fixtures.mjs';
import { APP_SCHEMA } from '../../service/storage/schema.js';
import { seedArtistResources } from '../../tests/artist-resources-fixtures.mjs';
import { packFixture,catalogFixture } from '../../tests/artist-pack-fixtures.mjs';
import { previewHtml, previewHtmlForResources, previewScript, previewSeedScript, previewImage } from './offline-preview.mjs';
import { seedPreparedArtists } from './seed-prepared-artists.mjs';


const preview = process.argv.includes('--preview');
function option(name) {const index=process.argv.indexOf(name);if(index<0)return null;const value=process.argv[index+1];if(!value||value.startsWith('--')||process.argv.lastIndexOf(name)!==index)throw new Error(`Invalid ${name}`);return value;}
const artistSource=option('--artist-source'),artistImages=option('--artist-images');
if(Boolean(artistSource)!==Boolean(artistImages)||(artistSource&&!preview))throw new Error('Prepared artists require --preview --artist-source <json> --artist-images <directory>');
if (!preview && !process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an existing Playwright index.mjs.');
const appRoot = path.resolve(import.meta.dirname, '..'), project = path.dirname(appRoot);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-native-integration-'));
const out = path.join(temporary, 'www'), dataRoot = path.join(temporary, 'data');
await fs.mkdir(dataRoot); await fs.mkdir(out);
const db = new DatabaseSync(path.join(dataRoot,'app.db'));
const media = new Map(); let vault = '{}', failedVault = false;
const generationCalls = [], encodingCalls = [], naxCalls = [];
let packMode='valid',packSequence=0;const packStages=new Set(),discardedPacks=[];
const recoveryCalls=[];
let downloadMode='valid',resumeDownload=null,installBarrier=null,resumeInstall=null,resumeCancelAck=null;
let packStatus={phase:'idle',receivedBytes:0,totalBytes:0,cancellable:false},packOperationId='';const packDownloads=[];
const token = 'pst-'+ 'fixture'.repeat(10), secondToken = 'pst-'+ 'second'.repeat(10), rbqToken = 'rbq-'+'fixture'.repeat(6);
const demoTokens = { token, secondToken, rbqToken }; let previewSeeded = false;
const png = makePngFixture({ width: 64, height: 64, rgba: Buffer.alloc(64 * 64 * 4, 255), entries: [{ type: 'tEXt', key: 'Software', value: 'NovelAI' }, { type: 'tEXt', key: 'Comment', value: JSON.stringify({ prompt: 'synthetic fixture', seed: 42, steps: 1 }) }] });
db.exec(APP_SCHEMA);
const resourceReview=artistSource?await seedPreparedArtists({db,dataRoot,sourceFile:artistSource,imageDirectory:artistImages}):null;
for(const item of resourceReview?[]:seedArtistResources(db)) {
  const file=path.join(dataRoot,item.path);await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,previewImage({input:'Synthetic artist resource',parameters:{width:512,height:768}},item.position));
}
const rpcCode = `const browserFetch = globalThis.fetch.bind(globalThis); async function rpc(name,args={}) { const response=await browserFetch('/fixture/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,args})});const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error),{code:value.code});return value; }`;
const sources = {
  '@capacitor/core': `${rpcCode} export const Capacitor={convertFileSrc:uri=>'/fixture/file?path='+encodeURIComponent(uri)}; export const registerPlugin=name=>new Proxy({}, {get:(_,method)=>(args)=>rpc(name+'.'+String(method),args)});`,
  '@capacitor/app': `const listeners=new Map();globalThis.fixtureApp={minimized:0,async emit(name){for(const listener of listeners.get(name)||[])await listener();}};export const App={addListener:async(name,listener)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(listener);return {remove(){listeners.get(name).delete(listener);}};},minimizeApp:async()=>{globalThis.fixtureApp.minimized++;}};`,
  '@capacitor/filesystem': `${rpcCode} export const Directory={Data:'DATA'};export const Filesystem=new Proxy({}, {get:(_,method)=>(args)=>rpc('Filesystem.'+String(method),args)});`,
  '@capacitor-community/sqlite': `${rpcCode} export const CapacitorSQLite={};export class SQLiteConnection {async createConnection(){return {open:async()=>{},execute:sql=>rpc('db.execute',{sql}),query:(sql,values)=>rpc('db.query',{sql,values}),run:(sql,values)=>rpc('db.run',{sql,values}),beginTransaction:()=>rpc('db.execute',{sql:'BEGIN'}),commitTransaction:()=>rpc('db.execute',{sql:'COMMIT'}),rollbackTransaction:()=>rpc('db.execute',{sql:'ROLLBACK'})};}}`
};
await build({absWorkingDir:appRoot,entryPoints:['src/main.js'],outdir:out,bundle:true,format:'esm',splitting:true,target:'chrome110',logLevel:'silent',plugins:[{name:'fixture-bridge',setup(build){
  build.onResolve({filter:/^@capacitor/},args=>sources[args.path]?{path:args.path,namespace:'fixture'}:undefined);
  build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:sources[args.path],loader:'js'}));
  build.onResolve({filter:/owner-features\.js(?:\?|$)/},()=>({path:path.join(appRoot,'src/owner-features.js')}));
  build.onResolve({filter:/\.js\?v=/},args=>({path:path.resolve(args.resolveDir,args.path.split('?')[0])}));
}}]});
await fs.copyFile(path.join(appRoot,'www/index.html'),path.join(out,'index.html'));
if (preview) {
  const html = await fs.readFile(path.join(out,'index.html'),'utf8');
  await fs.writeFile(path.join(out,'index.html'),html.replace('</body>','<script type="module" src="/fixture/seed.js"></script></body>'));
}
for(const name of ['styles.css','workspace.css','tag-chips.css','artist-browser.css','native.css','licenses.txt'])await fs.copyFile(path.join(appRoot,'www',name),path.join(out,name));
await fs.cp(path.join(appRoot,'www/icons'),path.join(out,'icons'),{recursive:true});
function local(name) { const file=path.resolve(dataRoot,String(name));if(!file.startsWith(dataRoot+path.sep))throw new Error('Fixture path escaped');return file; }
async function rpc(name,args) {
  if(name==='ArtistResources.recover') {
    if(!resourceReview)assert.ok(args.activeDirectories.includes('fixture-v1'),'startup recovery must protect seeded legacy resources');
    else assert.ok(args.activeDirectories.length>0,'startup recovery must protect selected resource mappings');
    if(packSequence>=3)assert.ok(args.activeDirectories.includes('mock-pack-3'),'recovery must read the latest committed mapping');
    recoveryCalls.push(args.activeDirectories);return {skipped:recoveryCalls.length>1};
  }
  if(name==='ArtistResources.status')return packStatus;
  if(name==='ArtistResources.readCatalog') {
    if(preview)throw new Error('真实目录下载需在安卓手机上验证；本预览只读取已载入的本地资料。');
    assert.deepEqual(Object.keys(args).sort(),['operationId','url']);return {catalog:catalogFixture().catalog};
  }
  if(name==='ArtistResources.cancelPack'){
    if(args.operationId===packOperationId)resumeDownload?.(true);
    await new Promise(resolve=>{resumeCancelAck=resolve;});return {};
  }
  if(name==='ArtistResources.importPack'||name==='ArtistResources.downloadPack') {
    if(preview)throw new Error(name==='ArtistResources.downloadPack'?'真实下载需在安卓手机上验证；本预览只读取已载入的本地资料。':'系统资料包文件选择需在安卓手机上验证；本预览没有导入文件。');
    packOperationId=args.operationId;
    if(name==='ArtistResources.importPack'&&packMode==='cancel')return {cancelled:true};
    if(name==='ArtistResources.downloadPack') {
      assert.deepEqual(Object.keys(args).sort(),args.expectedId?['expectedId','expectedVersion','operationId','sha256','url']:['operationId','sha256','url']);packDownloads.push(args);
      if(downloadMode==='wait') {
        packStatus={phase:'download',receivedBytes:1048576,totalBytes:2097152,cancellable:true};
        const cancelled=await new Promise(resolve=>{resumeDownload=resolve;});resumeDownload=null;
        if(cancelled){packStatus={phase:'idle',cancellable:false};return {cancelled:true};}
      }
    }
    packStatus={phase:'verify',receivedBytes:100,totalBytes:0,cancellable:true};
    packSequence++;const staged=args.expectedId?catalogFixture().staged:packFixture({version:String(packSequence)});staged.directory=`mock-pack-${packSequence}`;
    if(packMode==='catalog-mismatch')staged.manifest.version='unexpected';
    for(const file of staged.files){const target=local(`artist-resources/${staged.directory}/${file.name}`);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,staged.buffer);}
    delete staged.buffer;packStages.add(staged.directory);
    if(packMode==='corrupt')staged.files[0].sha256='0'.repeat(64);
    return staged;
  }
  if(name==='ArtistResources.retainPack'){packStages.delete(args.directory);return {};}
  if(name==='ArtistResources.discardPack') {
    assert.ok(/^mock-pack-\d+$/.test(args.directory)&&packStages.has(args.directory));
    const directory=local(`artist-resources/${args.directory}`);
    await fs.rm(directory,{recursive:true});packStages.delete(args.directory);discardedPacks.push(args.directory);return {};
  }
  if (preview && name === 'Fixture.claimSeed') { const seed = !previewSeeded; previewSeeded = true; return { seed, ...demoTokens }; }
  if(name==='db.execute'){db.exec(args.sql);return {};}
  if(name==='db.query')return {values:db.prepare(args.sql).all(...args.values)};
  if(name==='db.run'){
    if(installBarrier&&args.sql.includes('INSERT INTO artist_resource_observations'))await installBarrier;
    return {changes:{changes:Number(db.prepare(args.sql).run(...args.values).changes)}};
  }
  if(name==='PocketNative.readVault')return {value:vault};
  if(name==='PocketNative.writeVault'){
    if (preview && Object.values(JSON.parse(args.value).secrets || {}).some(value => !Object.values(demoTokens).includes(value))) throw new Error('体验预览只接受演示 Token；请勿填入真实凭据。');
    if(failedVault){failedVault=false;throw new Error('Synthetic vault commit failure');}vault=args.value;return {};
  }
  if(name==='PocketNative.diskStatus')return {freeBytes:1024**3,totalBytes:8*1024**3};
  if(name==='PocketNative.queueActive'||name==='PocketNative.cancelRequest')return {};
  if(name==='PocketNative.registerMedia'){for(const item of args.entries){if(item.remove)media.delete(item.route);else media.set(item.route,item);}return {};}
  if(name==='PocketNative.exportFile'){
    if (preview) throw new Error('系统文件导出需在安卓手机上确认；此预览没有保存文件。');
    return {saved:true};
  }
  if(name==='PocketNative.request'){
    const url=new URL(args.url);
    if(url.hostname==='cdn.zele.st'){
      assert.equal(args.method,'GET'); assert.equal(args.headers.authorization,undefined,'public examples receive no generation credential');
      naxCalls.push(url.pathname);
      return {status:200,headers:{'content-type':'image/png'},body:(preview?previewImage({input:'Synthetic artist example',parameters:{width:512,height:768}},naxCalls.length):png).toString('base64')};
    }
    if(['image.novelai.net','gnai.rbq.my'].includes(url.hostname)&&url.pathname==='/ai/generate-image'){
      const payload=JSON.parse(Buffer.from(args.body,'base64'));if (!preview) assert.ok(payload.input.includes('synthetic fixture'));
      generationCalls.push({host:url.hostname,authorization:args.headers.authorization,payload});
      if (preview) await new Promise(resolve=>setTimeout(resolve,800));
      return {status:200,headers:{'content-type':'image/png'},body:(preview ? previewImage(payload, generationCalls.length) : png).toString('base64')};
    }
    if(url.hostname==='image.novelai.net'&&url.pathname==='/ai/encode-vibe'){
      encodingCalls.push({authorization:args.headers.authorization,payload:JSON.parse(Buffer.from(args.body,'base64'))});
      assert.ok([`Bearer ${token}`,`Bearer ${secondToken}`].includes(args.headers.authorization),'Vibe encoding has an explicit official credential');
      return {status:200,headers:{'content-type':'application/octet-stream'},body:Buffer.from('synthetic-vibe-encoding').toString('base64')};
    }
    if(url.pathname==='/user/subscription')return {status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify({tier:3,trainingStepsLeft:{fixedTrainingStepsLeft:1000,purchasedTrainingSteps:0}})).toString('base64')};
    if(url.hostname==='gnai.rbq.my'&&url.pathname==='/user/info'){
      assert.equal(args.headers.authorization,`Bearer ${rbqToken}`);
      return {status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify({name:'Synthetic RBQ',is_active:true,total_images:2,quota_images:100,max_concurrent:1})).toString('base64')};
    }
    throw new Error(preview ? '此体验预览不连接外部服务，请在真机验证联网功能。' : 'Fixture forbids upstream network');
  }
  if(name==='Filesystem.mkdir'){await fs.mkdir(local(args.path),{recursive:args.recursive});return {};}
  if(name==='Filesystem.writeFile'){await fs.writeFile(local(args.path),Buffer.from(args.data,'base64'));return {};}
  if(name==='Filesystem.readFile')return {data:(await fs.readFile(local(args.path))).toString('base64')};
  if(name==='Filesystem.rename'){await fs.rename(local(args.from),local(args.to));return {};}
  if(name==='Filesystem.deleteFile'){await fs.unlink(local(args.path));return {};}
  if(name==='Filesystem.stat'){const stat=await fs.stat(local(args.path));return {type:stat.isFile()?'file':'directory',size:stat.size};}
  if(name==='Filesystem.getUri')return {uri:args.path};
  if(name==='Filesystem.readdir')return {files:(await fs.readdir(local(args.path))).map(name=>({name}))};
  throw new Error(`Unimplemented fixture port: ${name}`);
}
const mime=file=>file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream';
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) { res.writeHead(403); res.end(); return; }
    res.setHeader('Cache-Control','no-store');
    if (preview) {
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'");
      const pages = { '/': ['text/html',resourceReview?previewHtmlForResources(resourceReview):previewHtml], '/fixture/review.js': ['text/javascript',previewScript], '/fixture/seed.js': ['text/javascript',previewSeedScript] };
      if (pages[url.pathname]) { const [type,body] = pages[url.pathname]; res.setHeader('Content-Type',`${type}; charset=utf-8`); res.end(body); return; }
    }
    if(url.pathname==='/fixture/rpc'){
      if (req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json')) { res.writeHead(415); res.end(); return; }
      const chunks=[]; let size=0; for await(const chunk of req) { size+=chunk.length; if (size > 36*1024*1024) throw new Error('Fixture request too large'); chunks.push(chunk); } const call=JSON.parse(Buffer.concat(chunks));
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await rpc(call.name,call.args)));return;
    }
    if(url.pathname==='/fixture/file'){res.end(await fs.readFile(local(url.searchParams.get('path'))));return;}
    if(media.has(url.pathname)){const item=media.get(url.pathname);res.setHeader('Content-Type',item.mime);res.end(await fs.readFile(local(item.path)));return;}
    const file=path.resolve(out,'.'+(url.pathname==='/' || (preview && url.pathname==='/app')?'/index.html':url.pathname));
    if(!file.startsWith(out+path.sep))throw new Error('Fixture asset escaped');
    res.setHeader('Content-Type',mime(file));res.end(await fs.readFile(file));
  }catch(error){res.statusCode=error.code==='ENOENT'?404:500;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:error.message,code:error.code==='ENOENT'?'OS-PLUG-FILE-0008':error.code}));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
if (preview) {
  console.log(`Interactive preview: http://127.0.0.1:${server.address().port}/`);
  console.log(resourceReview?`Selected resource review: ${resourceReview.artists} artists, ${resourceReview.examples} examples, ${resourceReview.annotatedExamples} annotated. Credentials/generation remain synthetic; upstream network disabled.`:'Synthetic credentials and images only; upstream network disabled. Ctrl+C stops the preview.');
  console.log(`Disposable data: ${temporary}`);
  await new Promise(resolve => { process.once('SIGINT',resolve); process.once('SIGTERM',resolve); });
  server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); db.close();
} else {
const { chromium } = await import(pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)));
let browser;
try {
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:412,height:915}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(()=>globalThis.NAI_RUNTIME&& !document.querySelector('#appView').classList.contains('hidden'),{},{timeout:15000});
  assert.deepEqual(errors,[],'native app boots the real UI without missing imports/ports');
  assert.equal(await page.locator('[data-tab="artists"]').count(),1);
  const call=(url,body,method=body?'POST':'GET')=>page.evaluate(async({url,body,method})=>{const response=await fetch(url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};},{url,body,method});
  async function waitCompleted(count) {
    const deadline=Date.now()+20000;let jobs=[];
    while(Date.now()<deadline){jobs=(await call('/api/jobs')).data.jobs;if(jobs.filter(job=>job.status==='completed').length>=count||jobs.some(job=>job.status==='failed'))break;await new Promise(resolve=>setTimeout(resolve,100));}
    assert.equal(jobs.filter(job=>job.status==='completed').length,count,JSON.stringify(jobs));
  }
  await page.locator('#openSettingsButton').click();
  await page.locator('.provider-token-manager summary').click();
  await page.locator('#officialAccountName').fill('Synthetic');
  await page.locator('#officialApiToken').fill(token);
  failedVault=true;
  await page.locator('#saveOfficialTokenButton').click();
  await page.getByText('Synthetic vault commit failure',{exact:true}).waitFor();
  assert.equal((await call('/api/providers')).data.providers.official.accounts.length,0,'UI reports failure and rolls back the native snapshot');
  assert.equal(JSON.parse(vault).state,undefined,'failed commit never persists credentials');
  await page.locator('#saveOfficialTokenButton').click();
  await page.locator('#officialAccountList .provider-account-row').waitFor();
  assert.match(await page.locator('#officialAccountList').textContent(),/本机加密/);
  assert.equal(await page.locator('#officialApiToken').inputValue(),'');
  await page.locator('#officialAccountName').fill('Second');
  await page.locator('#officialApiToken').fill(secondToken);
  await page.locator('#saveOfficialTokenButton').click();
  await page.waitForFunction(()=>document.querySelectorAll('#officialAccountList .provider-account-row').length===2);
  const accounts=(await call('/api/providers')).data.providers.official.accounts;
  const accountId=accounts.find(item=>item.name==='Synthetic').id, secondId=accounts.find(item=>item.name==='Second').id;
  await page.locator('#generationProvider').selectOption('rbq');
  await page.locator('#rbqApiKey').fill(rbqToken);
  await page.locator('#saveRbqKeyButton').click();
  await page.getByText('RBQ Key 已在本机加密保存。',{exact:true}).waitFor();
  assert.equal(await page.locator('#rbqApiKey').inputValue(),'');
  await page.locator('#closeSettingsButton').click();
  await page.locator('[data-edit-text]').click();
  await page.locator('#promptPreview').fill('synthetic fixture');
  await page.locator('#floatingGenerateButton').click();
  await waitCompleted(1);
  assert.equal(generationCalls[0].host,'gnai.rbq.my');assert.equal(generationCalls[0].authorization,`Bearer ${rbqToken}`);
  await page.locator('#openSettingsButton').click();
  await page.locator('#generationProvider').selectOption('official');
  await page.locator('#officialAccountSelect').selectOption(secondId);
  await page.locator('#closeSettingsButton').click();
  await page.locator('#floatingGenerateButton').click();
  await waitCompleted(2);
  assert.equal(generationCalls[1].host,'image.novelai.net');assert.equal(generationCalls[1].authorization,`Bearer ${secondToken}`);
  // Recreate the WebView execution context: providers must reload from the vault.
  await page.reload();
  await page.waitForFunction(()=>globalThis.NAI_RUNTIME&&!document.querySelector('#appView').classList.contains('hidden'));
  const restored=(await call('/api/providers')).data.providers;
  assert.equal(restored.official.accounts.length,2);assert.equal(restored.rbq.configured,true);
  assert.ok(!JSON.stringify(restored).includes(token)&&!JSON.stringify(restored).includes(rbqToken));
  await page.locator('#openSettingsButton').click();
  assert.equal(await page.locator('#officialApiToken').inputValue(),'');assert.equal(await page.locator('#rbqApiKey').inputValue(),'');
  await page.locator('#generationProvider').selectOption('rbq');
  await page.locator('#officialAccountSelect').selectOption(accountId);
  await page.locator('#closeSettingsButton').click();
  const state={model:'nai-diffusion-4-5-full',prompt:'synthetic fixture',negativePrompt:'',provider:'official',officialAccountId:accountId,seed:42,seedMode:'fixed',params:{width:64,height:64,steps:1,scale:5}};
  const uploaded=await page.evaluate(async base64=>{const image=Uint8Array.from(atob(base64),x=>x.charCodeAt(0));const response=await fetch('/api/assets',{method:'POST',headers:{'Content-Type':'image/png'},body:image});return response.json();},png.toString('base64'));
  assert.equal(uploaded.width,64);assert.ok(uploaded.ref.id);
  const scheme=await call('/api/schemes',{name:'Offline fixture',data:state,isDefault:true});assert.equal(scheme.status,200);
  const vibe={...state,provider:'rbq',referenceControl:{mode:'vibe',vibes:[{image:uploaded.ref,strength:0.6,informationExtracted:1}]}};
  const missing=await call('/api/jobs/enqueue',{state:{...vibe,officialAccountId:''},count:1});assert.equal(missing.status,400);assert.equal(encodingCalls.length,0);
  page.once('dialog',dialog=>dialog.dismiss());
  const cancelled=await call('/api/jobs/enqueue',{state:vibe,count:1});assert.equal(cancelled.status,409);assert.equal(generationCalls.length,2);assert.equal(encodingCalls.length,0);
  page.once('dialog',dialog=>{assert.match(dialog.message(),/Synthetic/);return dialog.accept();});
  assert.equal((await call('/api/jobs/enqueue',{state:vibe,count:1})).status,200);
  await waitCompleted(3);
  assert.equal(encodingCalls.length,1);assert.equal(encodingCalls[0].authorization,`Bearer ${token}`);
  assert.equal(generationCalls[2].host,'gnai.rbq.my');assert.equal(generationCalls[2].authorization,`Bearer ${rbqToken}`);
  assert.equal(generationCalls[2].payload.parameters.reference_image_multiple[0],Buffer.from('synthetic-vibe-encoding').toString('base64'));
  // A cached reference can generate through RBQ without an official credential.
  assert.equal((await call('/api/jobs/enqueue',{state:{...vibe,officialAccountId:''},count:1})).status,200);
  await waitCompleted(4);assert.equal(encodingCalls.length,1);assert.equal(generationCalls.length,4);
  await call('/api/jobs/pause',{});
  assert.equal((await call('/api/jobs/enqueue',{state:vibe,count:1})).status,200);
  assert.equal((await call(`/api/providers/official/accounts/${accountId}`,null,'DELETE')).status,409,'pending RBQ Vibe keeps its official account pinned');
  await call('/api/jobs/cancel-all',{});await call('/api/jobs/resume',{});
  const gallery=await call('/api/images');assert.equal(gallery.data.images.length,4);const image=gallery.data.images[0];
  assert.equal(image.width,64);assert.equal(image.height,64);
  const favorite=await call(`/api/images/${image.id}/favorite`,{favorite:true});assert.equal(favorite.data.favorite,true);
  const exported=await call('/api/export');assert.equal(exported.data.schemes.length,1);for(const secret of [token,secondToken,rbqToken])assert.ok(!JSON.stringify(exported.data).includes(secret));
  const clean=await page.evaluate(async id=>{const response=await fetch(`/api/images/${id}/clean`);const blob=await response.blob();const image=await createImageBitmap(blob);return {status:response.status,width:image.width,type:blob.type};},image.id);
  assert.equal(clean.status,200);assert.equal(clean.width,64);assert.equal(clean.type,'image/png');
  await page.locator('[data-tab="gallery"]').click();
  await page.waitForFunction(()=>document.querySelector('#galleryGrid img')?.naturalWidth>0,{},{timeout:10000});
  await page.screenshot({path:path.join(temporary,'native-gallery.png'),fullPage:false});
  await page.locator('#openSettingsButton').click();
  await page.getByRole('button',{name:'关于 / 开源许可',exact:true}).click();
  await page.waitForSelector('.native-license-dialog[open]');
  assert.match(await page.locator('.native-license-dialog pre').textContent(),/GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.match(await page.locator('.native-license-dialog pre').textContent(),/SQLCipher/);
  await page.locator('.native-license-dialog button').click();
  await page.locator('#closeSettingsButton').click();
  await page.locator('[data-tab="editor"]').click();
  assert.equal(await page.locator('[data-storm-link]').count(),0);
  await page.locator('[data-edit-text]').click();
  if (!await page.locator('#promptPreview').isVisible()) await page.locator('[data-edit-text]').click();
  await page.locator('#promptPreview').fill('artist:anmi');
  await page.locator('#importPromptButton').click();
  await page.locator('[data-edit-text]').click();
  await page.locator('[data-artist-preview="artist:anmi"]:visible').first().click();
  await page.waitForFunction(()=>document.querySelector('#artistPreviewImage')?.naturalWidth>0&&!document.querySelector('#artistPreviewImage').classList.contains('hidden'));
  const previewUrl=await page.locator('#artistPreviewImage').getAttribute('src');
  assert.ok(previewUrl.startsWith('blob:'),'native image bytes use an object URL instead of an unreachable WebView API image route');
  assert.equal(naxCalls.length,1);assert.match(naxCalls[0],/\/anmi\.webp$/);
  await page.locator('#closeArtistPreviewDialog').click();
  assert.equal(await page.locator('#artistPreviewImage').getAttribute('src'),null);
  assert.equal(await page.evaluate(async url=>{try{await fetch(url);return false;}catch{return true;}},previewUrl),true,'closing releases the preview object URL');
  await page.screenshot({path:path.join(temporary,'native-editor.png'),fullPage:false});
  await page.locator('[data-tab="artists"]').click();
  await page.locator('.artist-browser-card').first().waitFor();
  assert.equal(await page.locator('.artist-browser-card').count(),24);
  await page.getByRole('searchbox',{name:'搜索画师',exact:true}).fill('anmi');
  const artistCard=page.locator('.artist-browser-card[data-artist="anmi"]');
  await artistCard.getByRole('button',{name:'收藏 anmi',exact:true}).click();
  await artistCard.getByRole('button',{name:'取消收藏 anmi',exact:true}).waitFor();
  await artistCard.locator('.artist-browser-image').click();
  await page.waitForFunction(()=>document.querySelector('.artist-browser-card[data-artist="anmi"] img')?.naturalWidth>0);
  await artistCard.getByRole('button',{name:'资料',exact:true}).click();
  await page.waitForFunction(()=>[...document.querySelectorAll('.artist-example-media img')].length===3&&[...document.querySelectorAll('.artist-example-media img')].every(image=>image.naturalWidth>0));
  const resourceUrls=await page.locator('.artist-example-media img').evaluateAll(images=>images.map(image=>image.src));
  assert.equal(naxCalls.length,1,'original examples never invoke NAX or upstream services');
  assert.equal(await page.locator('.artist-example-card').count(),3);
  await page.locator('[data-example-id="fixture-anmi-1"]').getByText('AI 初标 · 未人工确认',{exact:true}).waitFor();
  await page.locator('[data-example-id="fixture-anmi-2"]').getByText('人工已确认',{exact:true}).waitFor();
  await page.locator('[data-example-id="fixture-anmi-3"]').getByText('尚无标注',{exact:true}).waitFor();
  assert.match(await page.locator('[data-example-id="fixture-anmi-1"]').textContent(),/合成标注 A/);
  assert.doesNotMatch(await page.locator('[data-example-id="fixture-anmi-2"]').textContent(),/合成标注 A/);
  await page.setViewportSize({width:360,height:800});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'per-image annotations fit a narrow phone');
  await page.screenshot({path:path.join(temporary,'native-artist-resources.png'),fullPage:true});
  db.exec("CREATE TRIGGER refuse_artist_note BEFORE UPDATE ON artist_preferences WHEN NEW.note='synthetic-save-failure' BEGIN SELECT RAISE(ABORT,'Synthetic artist note save failure'); END;");
  await page.getByRole('textbox',{name:'画师备注',exact:true}).fill('synthetic-save-failure');
  await page.getByRole('button',{name:'保存备注',exact:true}).click();
  await page.getByText('Synthetic artist note save failure',{exact:true}).waitFor();
  await page.evaluate(()=>globalThis.fixtureApp.emit('backButton'));
  assert.equal(await page.evaluate(async urls=>(await Promise.all(urls.map(async url=>{try{await fetch(url);return false;}catch{return true;}}))).every(Boolean),resourceUrls),true,'leaving detail releases every local example object URL');
  await artistCard.getByRole('button',{name:'资料',exact:true}).click();
  assert.equal(await page.getByRole('textbox',{name:'画师备注',exact:true}).inputValue(),'synthetic-save-failure','failed saves retain the unsaved draft after navigation');
  await page.getByRole('textbox',{name:'画师备注',exact:true}).fill('星空方案，线条与色彩待比较。');
  await page.evaluate(()=>globalThis.fixtureApp.emit('backButton'));
  await page.getByRole('searchbox',{name:'搜索画师',exact:true}).waitFor();
  assert.equal(await page.locator('#artistsTab').evaluate(el=>el.classList.contains('active')),true,'native back returns from detail to the artist list');
  assert.equal(await page.getByRole('searchbox',{name:'搜索画师',exact:true}).inputValue(),'anmi');
  await artistCard.getByRole('button',{name:'资料',exact:true}).click();
  assert.equal(await page.getByRole('textbox',{name:'画师备注',exact:true}).inputValue(),'星空方案，线条与色彩待比较。','returning to an artist preserves its unsaved draft');
  assert.equal((await call('/api/artists/profile?artist=anmi')).data.artist.note,'','navigation does not silently save a draft');
  await page.locator('#openSettingsButton').click();
  await page.evaluate(()=>globalThis.fixtureApp.emit('backButton'));
  assert.equal(await page.locator('#settingsDialog').evaluate(el=>el.open),false,'back closes the top dialog before navigating');
  await page.getByRole('textbox',{name:'画师备注',exact:true}).waitFor();
  await page.getByRole('button',{name:'保存备注',exact:true}).click();
  await page.getByText('备注已保存在本机。',{exact:true}).waitFor();
  await page.evaluate(()=>{
    const original=window.fetch;
    window.fetch=(input,options)=>{
      if(input==='/api/artists/profile'&&options?.method==='PUT'&&JSON.parse(options.body).note==='first in flight'){
        window.fetch=original;const response=original(input,options);
        return new Promise(resolve=>{globalThis.fixtureResumeNote=async()=>resolve(await response);});
      }
      return original(input,options);
    };
  });
  await page.getByRole('textbox',{name:'画师备注',exact:true}).fill('first in flight');
  await page.getByRole('button',{name:'保存备注',exact:true}).click();
  await page.waitForFunction(()=>typeof globalThis.fixtureResumeNote==='function');
  await page.getByRole('textbox',{name:'画师备注',exact:true}).fill('星空方案，线条与色彩待比较。');
  await page.evaluate(()=>globalThis.fixtureResumeNote());
  await page.getByText('有未保存的修改。',{exact:true}).waitFor();
  assert.equal((await call('/api/artists/profile?artist=anmi')).data.artist.note,'first in flight','only the clicked snapshot is saved');
  await page.getByRole('button',{name:'保存备注',exact:true}).click();
  await page.getByText('备注已保存在本机。',{exact:true}).waitFor();
  await page.getByRole('button',{name:'‹ 返回画师列表',exact:true}).click();
  await page.locator('.artist-browser-style-filters summary').click();
  await page.getByRole('combobox',{name:'筛选维度',exact:true}).selectOption('line.weight');
  await page.getByRole('combobox',{name:'筛选特征',exact:true}).selectOption('fine');
  await page.getByRole('button',{name:'添加条件',exact:true}).click();
  await artistCard.waitFor();
  await page.getByRole('button',{name:'仅人工确认',exact:true}).click();
  await page.getByText('没有匹配的画师。',{exact:true}).waitFor();
  await page.getByRole('button',{name:'仅人工确认',exact:true}).click();
  await artistCard.waitFor();
  await page.getByRole('button',{name:'纤细 ×',exact:true}).click();
  await page.locator('.artist-browser-style-filters summary').click();
  await page.getByRole('button',{name:'只看收藏',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.artist-browser-card').length===1);
  await page.setViewportSize({width:360,height:800});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'artist browsing fits a narrow phone');
  await page.screenshot({path:path.join(temporary,'native-artists.png'),fullPage:false});
  await page.reload();
  await page.waitForFunction(()=>globalThis.NAI_RUNTIME&&!document.querySelector('#appView').classList.contains('hidden'));
  await page.locator('[data-tab="artists"]').click();
  await page.getByRole('button',{name:'只看收藏',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.artist-browser-card').length===1);
  const restoredArtist=(await call('/api/artists/profile?artist=anmi')).data.artist;
  assert.equal(restoredArtist.favorite,true);assert.equal(restoredArtist.note,'星空方案，线条与色彩待比较。');
  await page.locator('.artist-browser-card[data-artist="anmi"]').getByRole('button',{name:'加入画风',exact:true}).click();
  await page.locator('[data-tab="editor"]').click();
  assert.match(await page.locator('#promptPreview').inputValue(),/artist:anmi/);
  const artistBackup=(await call('/api/export')).data;
  assert.deepEqual(artistBackup.artistPreferences,[{artist:'anmi',favorite:true,note:'星空方案，线条与色彩待比较。'}]);
  for(const secret of [token,secondToken,rbqToken])assert.ok(!JSON.stringify(artistBackup).includes(secret));
  await call('/api/artists/profile',{artist:'anmi',favorite:false,note:'临时改动'},'PUT');
  await page.locator('[data-tab="artists"]').click();
  await page.locator('#importFile').setInputFiles({name:'artist-backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(artistBackup))});
  await page.getByText('备份已导入，包含 1 位画师的收藏和备注。',{exact:true}).waitFor();
  const importedCard=page.locator('.artist-browser-card[data-artist="anmi"]');
  await importedCard.getByRole('button',{name:'取消收藏 anmi',exact:true}).waitFor();
  await importedCard.getByRole('button',{name:'资料',exact:true}).click();
  assert.equal(await page.getByRole('textbox',{name:'画师备注',exact:true}).inputValue(),'星空方案，线条与色彩待比较。');
  await page.evaluate(()=>globalThis.fixtureApp.emit('backButton'));
  await page.getByRole('searchbox',{name:'搜索画师',exact:true}).waitFor();
  await page.evaluate(()=>globalThis.fixtureApp.emit('backButton'));
  assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('editor-tab-active')),true,'back from the artist list returns to the editor');
  await page.evaluate(()=>globalThis.fixtureApp.emit('backButton'));
  assert.equal(await page.evaluate(()=>globalThis.fixtureApp.minimized),1,'only the final back minimizes the app');
  await page.locator('[data-tab="artists"]').click();
  await call('/api/artists/profile',{artist:'fixture_artist',favorite:true,note:'保留个人备注'},'PUT');
  await page.getByRole('button',{name:'导入资料包',exact:true}).click();
  await page.getByText('已安装 1 位画师的 1 张例图及对应标注。',{exact:true}).waitFor();
  let importedResource=(await call('/api/artists/profile?artist=fixture_artist')).data.artist;
  assert.equal(importedResource.resourceSet.version,'1');assert.equal(importedResource.note,'保留个人备注');assert.equal(importedResource.favorite,true);
  await page.getByRole('searchbox',{name:'搜索画师',exact:true}).fill('fixture_artist');
  await page.locator('.artist-browser-card[data-artist="Fixture_Artist"]').getByRole('button',{name:'资料',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.artist-example-media img')?.naturalWidth===2);
  await page.getByRole('button',{name:'‹ 返回画师列表',exact:true}).click();
  packMode='corrupt';
  await page.getByRole('button',{name:'导入资料包',exact:true}).click();
  await page.getByText('资料包未安装，原有资料保持不变。',{exact:true}).waitFor();
  importedResource=(await call('/api/artists/profile?artist=fixture_artist')).data.artist;
  assert.equal(importedResource.resourceSet.version,'1');assert.deepEqual(discardedPacks,['mock-pack-2']);
  packMode='cancel';await page.getByRole('button',{name:'导入资料包',exact:true}).click();
  await page.getByText('已取消导入。',{exact:true}).waitFor();
  packMode='valid';downloadMode='wait';
  await page.locator('.artist-pack-download > summary').click();
  await page.getByText('已有单个 ZIP 下载链接',{exact:true}).click();
  await page.getByRole('textbox',{name:'资料包下载链接',exact:true}).fill('https://github.com/example/resources/releases/download/v1/artist-pack.zip');
  await page.getByRole('button',{name:'下载并安装',exact:true}).click();
  await page.getByText('正在下载 1.0 / 2.0 MB',{exact:true}).waitFor();
  assert.equal(await page.getByRole('progressbar',{name:'资料包处理进度',exact:true}).getAttribute('value'),'0.5');
  assert.equal(await page.getByRole('button',{name:'导入资料包',exact:true}).isDisabled(),true);
  await page.screenshot({path:path.join(temporary,'native-pack-progress.png'),fullPage:false});
  await page.getByRole('button',{name:'取消资料包操作',exact:true}).click();
  await page.getByText('已取消下载，原有资料保持不变。',{exact:true}).waitFor();
  assert.equal((await call('/api/artists/profile?artist=fixture_artist')).data.artist.resourceSet.version,'1');
  downloadMode='valid';installBarrier=new Promise(resolve=>{resumeInstall=resolve;});
  await page.getByRole('button',{name:'下载并安装',exact:true}).click();
  await page.getByText('正在安装资料，请保持应用在前台…',{exact:true}).waitFor();
  resumeCancelAck();await page.waitForTimeout(80);
  await page.getByText('正在安装资料，请保持应用在前台…',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'取消资料包操作',exact:true}).isDisabled(),true);
  assert.equal((await call('/api/artists/resources/cancel',{},'POST')).data.accepted,false,'commit cannot be interrupted halfway');
  resumeInstall();installBarrier=null;
  await page.getByText('已安装 1 位画师的 1 张例图及对应标注。',{exact:true}).waitFor();
  assert.equal((await call('/api/artists/profile?artist=fixture_artist')).data.artist.resourceSet.version,'3');
  assert.equal(packDownloads.length,2);for(const download of packDownloads)assert.ok(!JSON.stringify(download).includes(token)&&!JSON.stringify(download).includes(rbqToken));
  await page.getByRole('textbox',{name:'资料目录链接',exact:true}).fill('https://github.com/example/resources/releases/download/v1/catalog.json');
  await page.getByRole('button',{name:'读取资料目录',exact:true}).click();
  await page.getByText('已读取 1 个资料包。可按画师名查找并选择下载。',{exact:true}).waitFor();
  await page.getByRole('searchbox',{name:'查找画师资料包',exact:true}).fill('absent artist');
  await page.getByText('没有包含该画师的资料包。',{exact:true}).waitFor();
  await page.getByRole('searchbox',{name:'查找画师资料包',exact:true}).fill('catalog artist');
  const catalogCard=page.locator('[data-pack-id="catalog-test-10"]');await catalogCard.waitFor();
  await catalogCard.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'catalog fits the narrow viewport');
  await page.screenshot({path:path.join(temporary,'native-catalog-narrow.png'),fullPage:false});
  packMode='catalog-mismatch';await catalogCard.getByRole('button',{name:'下载并安装此包',exact:true}).click();
  await page.getByText('资料包未安装，原有资料保持不变。',{exact:true}).waitFor();
  assert.ok(discardedPacks.includes('mock-pack-4'));assert.equal((await call('/api/artists/profile?artist=fixture_artist')).data.artist.resourceSet.version,'3');
  packMode='valid';await catalogCard.getByRole('button',{name:'下载并安装此包',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-pack-id="catalog-test-10"] button')?.textContent==='已安装此版本');
  assert.equal(await catalogCard.getByRole('button',{name:'已安装此版本',exact:true}).isDisabled(),true);
  assert.equal((await call('/api/artists/profile?artist=catalog_artist')).data.artist.resourceSet.version,'catalog-v1');
  assert.equal(packDownloads.at(-1).sha256,'a'.repeat(64));assert.equal(packDownloads.at(-1).expectedVersion,'catalog-v1');
  await page.setViewportSize({width:820,height:900});await catalogCard.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(temporary,'native-catalog-wide.png'),fullPage:false});
  await page.reload();
  await page.waitForFunction(()=>globalThis.NAI_RUNTIME&&!document.querySelector('#appView').classList.contains('hidden'));
  assert.ok(recoveryCalls.length>=2,'startup reconciles from committed storage after a WebView reload');
  assert.ok(recoveryCalls.at(-1).includes('mock-pack-3'));
  assert.equal((await call('/api/artists/profile?artist=fixture_artist')).data.artist.resourceSet.version,'3');
  await fs.access(local('artist-resources/mock-pack-1/pack-example-preview.png'));
  assert.equal(await page.locator('[data-open-artist-rotation]').count(),0,'public browsing does not expose private automation');
  assert.deepEqual(errors,[]);
  console.log('Offline native wiring passed: UI token entry/rollback, dual-provider routing, Vibe consent/cache, gallery/export, public NAX preview, artist browsing/search/favorites/notes/reload/Prompt insertion/backup import, native back/draft retention and 360px layout. No upstream network used.');
  console.log(`Screenshot: ${path.join(temporary,'native-gallery.png')}`);
} finally { if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));db.close(); }
}
