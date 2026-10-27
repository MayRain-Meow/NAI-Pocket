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
import { packFixture,catalogFixture,examplesPackFixture,examplesCatalogFixture } from '../../tests/artist-pack-fixtures.mjs';
import { previewHtml, previewHtmlForResources, previewScript, previewSeedScript, previewImage } from './offline-preview.mjs';
import { seedPreparedArtists } from './seed-prepared-artists.mjs';
import { stylePackFixture } from '../../tests/style-pack-fixtures.mjs';


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
const albumCopies = []; let albumFailure = false;
const generationCalls = [], encodingCalls = [], naxCalls = [], danbooruCalls = [];
let packMode='valid',packSequence=0;const packStages=new Set(),discardedPacks=[];
const recoveryCalls=[];
// App update: GitHub Releases API through the fixture HTTP port, native download/install stubs.
const appVersion=JSON.parse(await fs.readFile(path.join(import.meta.dirname,'../package.json'),'utf8')).version;
const newerVersion=appVersion.replace(/\d+$/,patch=>String(Number(patch)+1));
const releaseAssetBase='https://github.com/MayRain-Meow/NAI-Pocket/releases/download/';
const releaseFixture=version=>({tag_name:`v${version}-preview`,name:`NAI Pocket ${version} preview`,draft:false,prerelease:true,body:'## 本版\n- **新增** 应用内更新\n- 修复若干问题\n- 第四行不显示',
  assets:[`NAI-Pocket-v${version}-preview.apk`,`NAI-Pocket-v${version}-preview.apk.sha256`,`NAI-Pocket-v${version}-source.zip`].map(name=>({name,size:1024,browser_download_url:`${releaseAssetBase}v${version}-preview/${name}`}))});
let githubReleases=[releaseFixture(appVersion)];const githubCalls=[],updateDownloads=[],updateInstalls=[];
let downloadMode='valid',resumeDownload=null,installBarrier=null,resumeInstall=null,resumeCancelAck=null;
let packStatus={phase:'idle',receivedBytes:0,totalBytes:0,cancellable:false},packOperationId='';const packDownloads=[];
// 画风数据: watercolor is axis 0, so "fixture same image" (pure axis 0) ranks first for 水彩.
const styleFixture=stylePackFixture([['fixture-anmi-1','anmi',[60,90,0,0]],['fixture-anmi-2','anmi',[40,0,100,0]],['fixture-same-1','fixture same image',[127,0,0,0]]],{tags:{anmi:['gloomy']}});
// 0.7.1: the same release carries the V5 samples' index (依据 V5 出图 / 混合); here it ranks the other way round.
const styleV5Fixture=stylePackFixture([['v5-anmi','anmi',[127,0,0,0]],['v5-same','fixture same image',[0,0,127,0]]],{version:'fixture-1-v5'});
styleFixture.manifest.v5={version:'fixture-1-v5',images:2,artists:2,file:styleV5Fixture.manifest.file};
let styleMode='valid';const styleDownloads=[];
// 以图找画师: a synthetic model bridge. The "embedding" points along axis 0, so 'fixture same image' wins.
const modelBase='https://github.com/MayRain-Meow/NAI-Pocket/releases/download/style-model-clip-vit-l14';
const modelManifest={format:'nai-pocket-style-model',formatVersion:1,model:'clip-vit-large-patch14-vision-int8',file:{url:`${modelBase}/vision.onnx`,bytes:307001500,sha256:'c'.repeat(64)}};
let modelPresent=false;const modelDownloads=[],embedCalls=[];
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
for(const name of ['styles.css','workspace.css','tag-chips.css','artist-browser.css','artist-library.css','native.css','licenses.txt'])await fs.copyFile(path.join(appRoot,'www',name),path.join(out,name));
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
  if(name==='ArtistResources.readCatalog'&&String(args.url).endsWith('/style-model.json')) {
    if(preview)throw new Error('真实模型下载需在安卓手机上验证。');
    assert.equal(args.url,`${modelBase}/style-model.json`);return {catalog:modelManifest};
  }
  if(name.startsWith('StyleEmbed.')) {
    if(name==='StyleEmbed.modelStatus')return {present:modelPresent,bytes:modelPresent?307001500:0};
    if(name==='StyleEmbed.status')return {busy:false,receivedBytes:0,totalBytes:0};
    if(name==='StyleEmbed.cancel')return {};
    if(name==='StyleEmbed.deleteModel'){modelPresent=false;return {};}
    if(name==='StyleEmbed.downloadModel'){
      if(preview)throw new Error('真实模型下载需在安卓手机上验证。');
      assert.deepEqual(Object.keys(args).sort(),['operationId','sha256','url']);modelDownloads.push(args);modelPresent=true;return {bytes:307001500};
    }
    if(name==='StyleEmbed.embed'){
      assert.ok(typeof args.data==='string'&&args.data.length>100,'the picture reaches the native side as base64');
      embedCalls.push(args.data.length);return {vector:[1,0,0,0]};
    }
  }
  if(name==='ArtistResources.readCatalog'&&String(args.url).endsWith('/style-index.json')) {
    if(preview)throw new Error('真实画风数据下载需在安卓手机上验证。');
    assert.deepEqual(Object.keys(args).sort(),['operationId','url']);return {catalog:styleFixture.manifest};
  }
  if(name==='ArtistResources.downloadStyleIndex') {
    if(preview)throw new Error('真实画风数据下载需在安卓手机上验证。');
    assert.deepEqual(Object.keys(args).sort(),['operationId','sha256','url']);styleDownloads.push(args);
    const target=local(`style-index/${args.sha256}.bin`);await fs.mkdir(path.dirname(target),{recursive:true});
    // 'corrupt': the native checksum passed but the content does not decode (truncated pack).
    const source=args.sha256===styleV5Fixture.sha256?styleV5Fixture.bytes:styleFixture.bytes;
    await fs.writeFile(target,styleMode==='corrupt'?source.subarray(0,40):source);
    return {path:`style-index/${args.sha256}.bin`,bytes:source.length};
  }
  if(name==='ArtistResources.readCatalog'&&String(args.url).endsWith('/artist-v5-examples-2026-10-22/catalog.json')) {
    if(preview)throw new Error('真实例图目录需在安卓手机上验证。');
    return {catalog:examplesCatalogFixture()};
  }
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
    packSequence++;const staged=args.expectedId?.startsWith('v5-examples')?examplesPackFixture():args.expectedId?catalogFixture().staged:packFixture({version:String(packSequence)});staged.directory=`mock-pack-${packSequence}`;
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
  if(name.startsWith('AppUpdate.')) {
    if(preview)throw new Error('应用更新需在安卓手机上验证；本预览不下载安装包。');
    if(name==='AppUpdate.updateStatus')return {phase:'download',receivedBytes:512,totalBytes:1024};
    if(name==='AppUpdate.cancelUpdate')return {};
    if(name==='AppUpdate.downloadUpdate'){updateDownloads.push(args);return {path:'/data/user/0/app.naipocket.local/cache/updates/NAI-Pocket-update.apk',sha256:'a'.repeat(64),verified:true,bytes:1024};}
    if(name==='AppUpdate.installUpdate'){updateInstalls.push(args);return updateInstalls.length===1?{needsPermission:true}:{started:true};}
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
  if(name==='PocketNative.requestGalleryAccess')return {granted:true};
  if(name==='PocketNative.saveToGallery'){
    if (preview) throw new Error('手机相册复制需在安卓手机上验证；此预览没有写入相册。');
    albumCopies.push(args);await fs.access(local(args.path));
    if(albumFailure)throw new Error('Synthetic album write failure');
    return {saved:true,uri:'content://media/external/images/media/'+albumCopies.length};
  }
  if(name==='PocketNative.exportFile'){
    if (preview) throw new Error('系统文件导出需在安卓手机上确认；此预览没有保存文件。');
    return {saved:true};
  }
  if(name==='PocketNative.request'){
    const url=new URL(args.url);
    if(url.hostname==='cdn.donmai.us'){
      assert.equal(args.method,'GET');assert.deepEqual(Object.keys(args.headers).map(key=>key.toLowerCase()).filter(key=>!['accept','user-agent'].includes(key)),[],'annotation thumbnails send no credentials');
      danbooruCalls.push(url.pathname);
      return {status:200,headers:{'content-type':'image/jpeg'},body:Buffer.from('ffd8ffc0001108000200020301220002110103110100ffd9','hex').toString('base64')};
    }
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
    if(url.hostname==='relay.example.test'&&url.pathname==='/v1/generate'){
      const payload=JSON.parse(Buffer.from(args.body,'base64'));
      generationCalls.push({host:url.hostname,authorization:args.headers.authorization,payload});
      // OpenAI-shaped JSON under a generic content-type: recognised by its content.
      return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from(JSON.stringify({created:1,data:[{b64_json:png.toString('base64')}]})).toString('base64')};
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
    if(!preview&&url.hostname==='api.github.com'&&url.pathname==='/repos/MayRain-Meow/NAI-Pocket/releases'){
      assert.equal(args.method,'GET');assert.equal(url.search,'?per_page=10');
      assert.equal(Object.keys(args.headers).some(key=>['authorization','cookie'].includes(key.toLowerCase())),false,'the update check sends no credentials');
      githubCalls.push(url.search);
      return {status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(githubReleases)).toString('base64')};
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
  if (process.argv.includes('--relay-settings-only')) {
    const { runRelaySettingsChecks } = await import('./relay-settings.test.mjs');
    await runRelaySettingsChecks({ page, getVault: () => JSON.parse(vault), generationCalls, temporary });
    assert.deepEqual(errors, [], 'relay settings UI has no uncaught browser errors');
  } else {
  assert.equal(await page.locator('[data-tab="artists"]').count(),1);
  // Issue #1: exercise the built HTML, including a second public-export build.
  // These are WebView content sizes after native padding, not an Android inset emulator.
  const viewportContent = await page.locator('meta[name="viewport"]').getAttribute('content');
  assert.doesNotMatch(viewportContent, /viewport-fit\s*=\s*cover/i, 'native SystemBars must own the safe area');
  assert.match(viewportContent, /width=device-width/);
  async function assertTouchable(selector) {
    assert.equal(await page.locator(selector).evaluate(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 &&
        r.right <= innerWidth && r.bottom <= innerHeight &&
        el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }), true, `${selector} stays visible and receives taps inside the content viewport`);
  }
  for (const size of [{width:360,height:720},{width:412,height:820}]) {
    await page.setViewportSize(size);
    await assertTouchable('#openSettingsButton');
    await page.locator('#openSettingsButton').click();
    await assertTouchable('#closeSettingsButton');
    await page.locator('#settingsDialog').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await assertTouchable('#closeSettingsButton');
    await page.locator('#settingsDialog').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({path:path.join(temporary,`native-settings-safe-area-${size.width}.png`)});
    await page.locator('#closeSettingsButton').click();
    assert.equal(await page.locator('#settingsDialog').evaluate(el => el.open), false);
    await assertTouchable('[data-tab="queue"]');
    await page.locator('[data-tab="queue"]').click();
    assert.equal(await page.locator('#queueTab').isVisible(), true);
    await page.screenshot({path:path.join(temporary,`native-navigation-safe-area-${size.width}.png`)});
    await page.locator('[data-tab="editor"]').click();
  }
  await page.setViewportSize({width:412,height:915});
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
  // RBQ is a third-party relay preset: it joins the channel list once its Key is saved.
  assert.equal(await page.locator('#generationProvider option[value="rbq"]').count(),0,'RBQ is not offered before it has a Key');
  await page.locator('#relayManager > summary').click();
  await page.locator('#rbqApiKey').fill(rbqToken);
  await page.locator('#saveRbqKeyButton').click();
  await page.getByText('RBQ Key 已在本机加密保存。',{exact:true}).waitFor();
  assert.equal(await page.locator('#generationProvider').inputValue(),'rbq','saving the first RBQ Key switches to it');
  assert.equal(await page.locator('#rbqApiKey').inputValue(),'');
  await page.locator('#closeSettingsButton').click();
  await page.locator('[data-edit-text]').click();
  await page.locator('#promptPreview').fill('synthetic fixture');
  await page.locator('#floatingGenerateButton').click();
  await waitCompleted(1);
  const waitAlbum=async count=>{const deadline=Date.now()+5000;while(albumCopies.length<count&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));assert.equal(albumCopies.length,count,'album copy attempts');};
  await waitAlbum(1);
  assert.match(albumCopies[0].path,/^originals\/\d{4}\/\d{2}\/[\w-]+\.png$/);assert.equal(albumCopies[0].mime,'image/png');
  assert.match(albumCopies[0].name,/^nai-\d{4}-\d{2}-\d{2}T[\d-]+Z\.png$/,'album copy keeps the download file name');
  assert.equal(albumCopies[0].data,undefined,'native reads the original file; bytes are not re-encoded in JS');
  albumFailure=true;
  assert.equal(generationCalls[0].host,'gnai.rbq.my');assert.equal(generationCalls[0].authorization,`Bearer ${rbqToken}`);
  await page.locator('#openSettingsButton').click();
  await page.locator('#generationProvider').selectOption('official');
  await page.locator('#officialAccountSelect').selectOption(secondId);
  await page.locator('#closeSettingsButton').click();
  await page.locator('#floatingGenerateButton').click();
  await waitCompleted(2);
  await waitAlbum(2);albumFailure=false;
  await page.getByText(/复制到手机相册失败：Synthetic album write failure/).first().waitFor();
  const albumJobs=(await call('/api/jobs')).data.jobs;
  assert.deepEqual(albumJobs.map(job=>[job.status,job.attempts]),[['completed',1],['completed',1]],'album failure neither fails nor retries the job');
  const albumLogs=await Promise.all(albumJobs.map(async job=>(await call(`/api/jobs/${job.id}/logs`)).data.logs.filter(entry=>entry.phase==='phone-gallery').map(entry=>entry.level)));
  assert.deepEqual(albumLogs.flat().sort(),['info','warn'],'each album outcome is logged on its job');
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
  assert.equal(await page.locator('#nativePhoneAlbumToggle').isChecked(),true,'phone album copy defaults to on');
  await page.getByText('保存到手机相册',{exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('#nativePhoneAlbumToggle').checked);
  const albumSetting=()=>db.prepare("SELECT value FROM app_state WHERE key='phone_gallery_copy'").get()?.value;
  { const deadline=Date.now()+3000;while(albumSetting()!=='0'&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50)); }
  assert.equal(albumSetting(),'0','switch persists in the native SQLite state');
  await page.locator('#closeSettingsButton').click();
  const state={model:'nai-diffusion-4-5-full',prompt:'synthetic fixture',negativePrompt:'',provider:'official',officialAccountId:accountId,seed:42,seedMode:'fixed',params:{width:64,height:64,steps:1,scale:5}};
  const uploaded=await page.evaluate(async base64=>{const image=Uint8Array.from(atob(base64),x=>x.charCodeAt(0));const response=await fetch('/api/assets',{method:'POST',headers:{'Content-Type':'image/png'},body:image});return response.json();},png.toString('base64'));
  assert.equal(uploaded.width,64);assert.ok(uploaded.ref.id);
  const scheme=await call('/api/schemes',{name:'Offline fixture',data:state,isDefault:true});assert.equal(scheme.status,200);
  const vibe={...state,provider:'rbq',referenceControl:{mode:'vibe',vibes:[{image:uploaded.ref,strength:0.6,informationExtracted:1}]}};
  const missing=await call('/api/jobs/enqueue',{state:{...vibe,officialAccountId:''},count:1});assert.equal(missing.status,400);assert.equal(encodingCalls.length,0);
  // The Vibe encoding confirmation is the in-app sheet: cancel queues nothing, accept encodes once.
  const cancelling=call('/api/jobs/enqueue',{state:vibe,count:1});
  await page.locator('.confirm-sheet[open] [data-confirm-cancel]').click();
  const cancelled=await cancelling;assert.equal(cancelled.status,409);assert.equal(generationCalls.length,2);assert.equal(encodingCalls.length,0);
  const accepting=call('/api/jobs/enqueue',{state:vibe,count:1});
  assert.match(await page.locator('.confirm-sheet[open]').textContent(),/Synthetic/);
  await page.locator('.confirm-sheet[open] [data-confirm-accept]').click();
  assert.equal((await accepting).status,200);
  await waitCompleted(3);
  assert.equal(encodingCalls.length,1);assert.equal(encodingCalls[0].authorization,`Bearer ${token}`);
  assert.equal(generationCalls[2].host,'gnai.rbq.my');assert.equal(generationCalls[2].authorization,`Bearer ${rbqToken}`);
  assert.equal(generationCalls[2].payload.parameters.reference_image_multiple[0],Buffer.from('synthetic-vibe-encoding').toString('base64'));
  // A cached reference can generate through RBQ without an official credential.
  assert.equal((await call('/api/jobs/enqueue',{state:{...vibe,officialAccountId:''},count:1})).status,200);
  await waitCompleted(4);assert.equal(encodingCalls.length,1);assert.equal(generationCalls.length,4);
  await new Promise(resolve=>setTimeout(resolve,300));assert.equal(albumCopies.length,2,'switched off: later images are not copied');
  await call('/api/jobs/pause',{});
  assert.equal((await call('/api/jobs/enqueue',{state:vibe,count:1})).status,200);
  assert.equal((await call(`/api/providers/official/accounts/${accountId}`,null,'DELETE')).status,409,'pending RBQ Vibe keeps its official account pinned');
  await call('/api/jobs/cancel-all',{});await call('/api/jobs/resume',{});
  // A NovelAI-compatible relay added in Settings becomes the channel and receives its own Key.
  await page.locator('#openSettingsButton').click();
  if (!(await page.locator('#relayManager').evaluate(node=>node.open))) await page.locator('#relayManager > summary').click();
  await page.locator('#relayKind').selectOption('custom');
  await page.locator('#relayName').fill('Synthetic relay');
  await page.locator('#relayApiUrl').fill('https://relay.example.test/v1/generate');
  await page.locator('#rbqApiKey').fill('synthetic-relay-key-123');
  await page.locator('#saveRbqKeyButton').click();
  await page.getByText('中转已保存，并设为当前通道。',{exact:true}).waitFor();
  assert.match(await page.locator('#generationProvider').inputValue(),/^relay:/);
  assert.match(await page.locator('#relayList').textContent(),/Synthetic relay/);
  await page.locator('#closeSettingsButton').click();
  await page.locator('#floatingGenerateButton').click();
  await waitCompleted(5);
  assert.equal(generationCalls.at(-1).host,'relay.example.test');assert.equal(generationCalls.at(-1).authorization,'Bearer synthetic-relay-key-123');
  const gallery=await call('/api/images');assert.equal(gallery.data.images.length,5);const image=gallery.data.images[0];
  assert.equal(image.width,64);assert.equal(image.height,64);
  const favorite=await call(`/api/images/${image.id}/favorite`,{favorite:true});assert.equal(favorite.data.favorite,true);
  const exported=await call('/api/export');assert.equal(exported.data.schemes.length,1);for(const secret of [token,secondToken,rbqToken,'synthetic-relay-key-123'])assert.ok(!JSON.stringify(exported.data).includes(secret));
  const clean=await page.evaluate(async id=>{const response=await fetch(`/api/images/${id}/clean`);const blob=await response.blob();const image=await createImageBitmap(blob);return {status:response.status,width:image.width,type:blob.type};},image.id);
  assert.equal(clean.status,200);assert.equal(clean.width,64);assert.equal(clean.type,'image/png');
  await page.locator('[data-tab="gallery"]').click();
  await page.waitForFunction(()=>document.querySelector('#galleryGrid img')?.naturalWidth>0,{},{timeout:10000});
  await page.screenshot({path:path.join(temporary,'native-gallery.png'),fullPage:false});
  await page.locator('#openSettingsButton').click();
  // Settings → 关于 carries the author and the repository, and opens the licence view.
  const about=page.locator('.native-about-section');
  assert.match(await about.textContent(),/MayRain-Meow/);
  assert.equal(await about.locator('a.native-about-link').getAttribute('href'),'https://github.com/MayRain-Meow/NAI-Pocket');
  assert.equal(await about.locator('a.native-star-button').getAttribute('href'),'https://github.com/MayRain-Meow/NAI-Pocket');
  await about.getByRole('button',{name:'开源许可',exact:true}).click();
  await page.waitForSelector('.native-license-dialog[open]');
  assert.match(await page.locator('.native-license-dialog pre').textContent(),/GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.match(await page.locator('.native-license-dialog pre').textContent(),/SQLCipher/);
  await page.locator('.native-license-dialog button').click();
  await page.locator('#closeSettingsButton').click();
  // 0.7.0: 反推 has its own tab; without a server it is the WD Tagger only (no AI 草稿, no 设置).
  await page.locator('[data-tab="reverse"]').click();
  await page.waitForFunction(()=>document.querySelector('#reverseWorkspace .reverse-empty p')?.textContent.includes('从图里认出 Tag'),{},{timeout:10000});
  assert.equal(await page.locator('#reverseWorkspace .tagger-settings-button').count(),0);
  await page.screenshot({path:path.join(temporary,'native-reverse.png'),fullPage:false});
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
  // The artist page is the shared artist-library UI without management (canManage false).
  await page.locator('[data-tab="artists"]').click();
  const library=page.locator('#artistLibraryMount'),searchBox=library.locator('input[name="query"]');
  const libraryCard=name=>library.locator(`.artist-library-card[data-artist-card="${name}"]`);
  const cardNames=()=>library.locator('.artist-library-card').evaluateAll(nodes=>nodes.map(node=>node.dataset.artistCard));
  const openFilters=async()=>{const toggle=library.locator('.artist-library-filter-toggle');if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();};
  const libraryBack=()=>page.evaluate(()=>!window.dispatchEvent(new Event('nai-navigation-back',{cancelable:true})));
  await library.locator('.artist-library-card').first().waitFor();
  assert.ok(await library.locator('.artist-library-card').count()>=3,'roster and installed artists render as cards');
  for(const selector of ['.artist-library-manage-toggle','[data-open-artist-tasks]','[data-open-artist-rotation]','[data-open-nax-mirror]','[data-open-similar]','[data-library-coverage]'])
    assert.equal(await page.locator(`${selector}:visible`).count(),0,`${selector}: library management is absent in the app`);
  await searchBox.fill('anmi');
  await page.waitForFunction(()=>{const names=[...document.querySelectorAll('#artistLibraryMount .artist-library-card')].map(node=>node.dataset.artistCard);return names.includes('anmi')&&names.length<10;});
  assert.ok((await cardNames()).every(name=>name.includes('anmi')),'name search narrows the list');
  const artistCard=libraryCard('anmi');
  await artistCard.getByRole('button',{name:'收藏 anmi',exact:true}).click();
  await artistCard.getByRole('button',{name:'取消收藏 anmi',exact:true}).waitFor();
  assert.equal((await call('/api/artists/profile?artist=anmi')).data.artist.favorite,true,'card favourite persists');
  await artistCard.getByRole('button',{name:'查看 anmi 的资料与例图',exact:true}).click();
  await library.locator('.artist-library-example-card').nth(2).waitFor();
  assert.equal(await library.locator('.artist-library-example-card').count(),3);
  for(const image of await library.locator('.artist-library-example-image').all()) {
    await image.scrollIntoViewIfNeeded();
    await page.waitForFunction(node=>node.naturalWidth>0&&node.src.startsWith('blob:'),await image.elementHandle());
  }
  assert.equal(naxCalls.length,1,'original examples never invoke NAX or upstream services');
  // 0.7.2 (website 1.9.40): the per-image annotations are retired — pictures carry no tag chips and no
  // 查看标注; tapping a picture opens it large, without its annotation.
  const viewer=page.locator('.artist-result-dialog');
  assert.equal(await library.locator('[data-example-evidence] .artist-library-chip:visible').count(),0,'pictures carry no tag chips');
  assert.equal(await library.locator('[data-view-annotation], [data-annotate-example], [data-evidence-annotate]').count(),0,'no annotation entries on pictures');
  await library.locator('.artist-library-example-image').first().click();
  await viewer.locator('.artist-result-media img').waitFor();
  assert.match(await viewer.textContent(),/例图 · anmi/);
  assert.doesNotMatch(await viewer.textContent(),/判断依据|未人工确认|人工已确认|编辑标注/,'the viewer shows the picture, not its annotation');
  await viewer.getByRole('button',{name:'关闭',exact:true}).click();
  // 1.7.2 / 0.5.0: without management and before 画风数据 is installed the icon bar is only 笔记;
  // 画风概览 opens from the vibe line under the name.
  assert.deepEqual(await library.locator('.artist-library-detail-actions > button').allTextContents(),['笔记'],'no management actions without management');
  assert.equal(await library.locator('[data-artist-vibe-tags] [data-open-artist-panel="evidence"]').count(),1,'画风概览 opens from the vibe line');
  assert.equal(await library.locator('[data-generate-artist-samples]').count(),0);
  const exampleMenu=library.locator('[data-example-id="fixture-anmi-1"] .artist-library-example-menu');
  await exampleMenu.locator('summary').click();
  await exampleMenu.locator('.artist-library-example-menu-body').waitFor();
  assert.deepEqual(await exampleMenu.locator('.artist-library-example-menu-body button').allTextContents(),[],'the example menu has no 编辑标注/设为封面/删除 without management');
  assert.match(await exampleMenu.textContent(),/打开来源链接/);
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:360,height:800});
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'the artist detail fits a narrow phone');
  await page.screenshot({path:path.join(temporary,'native-artist-resources.png'),fullPage:true});
  // Notes are edited in the 资料 sheet; a failed save is reported and nothing is stored.
  await library.locator('[data-open-artist-panel="profile"]').click();
  const profilePanel=library.locator('[data-artist-panel="profile"]'),noteBox=profilePanel.locator('textarea[name="note"]');
  db.exec("CREATE TRIGGER refuse_artist_note BEFORE UPDATE ON artist_preferences WHEN NEW.note='synthetic-save-failure' BEGIN SELECT RAISE(ABORT,'Synthetic artist note save failure'); END;");
  await noteBox.fill('synthetic-save-failure');
  await profilePanel.getByRole('button',{name:'保存资料',exact:true}).click();
  await page.getByText('Synthetic artist note save failure',{exact:true}).first().waitFor();
  assert.equal((await call('/api/artists/profile?artist=anmi')).data.artist.note,'','a failed save stores nothing');
  await noteBox.fill('星空方案，线条与色彩待比较。');
  await profilePanel.getByRole('button',{name:'保存资料',exact:true}).click();
  await page.getByText('画师资料已保存。',{exact:true}).first().waitFor();
  assert.equal((await call('/api/artists/profile?artist=anmi')).data.artist.note,'星空方案，线条与色彩待比较。','note saved from the 资料 panel persists');
  await profilePanel.getByRole('button',{name:'关闭',exact:true}).click();
  // Back navigation: an open dialog closes first (here the picture viewer), then the detail.
  await library.locator('.artist-library-example-image').first().click();
  await viewer.locator('.artist-result-media img').waitFor();
  await page.evaluate(()=>globalThis.fixtureApp.emit('backButton'));
  assert.equal(await viewer.evaluate(node=>node.open),false,'native back closes the open dialog first');
  assert.equal(await library.locator('.artist-library-detail-toolbar').isVisible(),true,'closing the dialog keeps the detail');
  await page.locator('#openSettingsButton').click();
  await page.evaluate(()=>globalThis.fixtureApp.emit('backButton'));
  assert.equal(await page.locator('#settingsDialog').evaluate(el=>el.open),false,'back closes the top dialog before navigating');
  assert.equal(await library.locator('.artist-library-detail-toolbar').isVisible(),true);
  await page.evaluate(()=>globalThis.fixtureApp.emit('backButton'));
  await artistCard.waitFor();
  assert.equal(await library.locator('.artist-library-detail-toolbar').count(),0,'native back returns from detail to the artist list');
  assert.equal(await page.locator('#artistsTab').evaluate(el=>el.classList.contains('active')),true,'back from detail stays on the artist tab');
  assert.equal(await searchBox.inputValue(),'anmi','the list comes back with its search');
  // Style filters narrow results.
  await openFilters();
  // 0.7.2: 标注筛选 is retired (website 1.9.40); the panel is 依据 + 感觉词, and 收藏 still narrows the list.
  assert.equal(await library.locator('.artist-filter-labels, .artist-library-refined-filters, input[name="confirmedOnly"], input[name="annotated"]').count(),0,'no annotation filters');
  await searchBox.fill('');
  await page.waitForFunction(()=>{const names=[...document.querySelectorAll('#artistLibraryMount .artist-library-card')].map(node=>node.dataset.artistCard);return names.length>1&&names.includes('anmi');});
  await library.locator('label:has(input[name="favorite"])').click();
  await page.waitForFunction(()=>[...document.querySelectorAll('#artistLibraryMount .artist-library-card')].map(node=>node.dataset.artistCard).join()==='anmi');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'artist browsing fits a narrow phone');
  await page.screenshot({path:path.join(temporary,'native-artists.png'),fullPage:false});
  await page.reload();
  await page.waitForFunction(()=>globalThis.NAI_RUNTIME&&!document.querySelector('#appView').classList.contains('hidden'));
  await page.locator('[data-tab="artists"]').click();
  await library.locator('.artist-library-card').first().waitFor();
  await openFilters();
  await library.locator('label:has(input[name="favorite"])').click();
  await page.waitForFunction(()=>[...document.querySelectorAll('#artistLibraryMount .artist-library-card')].map(node=>node.dataset.artistCard).join()==='anmi');
  const restoredArtist=(await call('/api/artists/profile?artist=anmi')).data.artist;
  assert.equal(restoredArtist.favorite,true);assert.equal(restoredArtist.note,'星空方案，线条与色彩待比较。');
  await libraryCard('anmi').getByRole('button',{name:'把 anmi 加入画风',exact:true}).click();
  await page.locator('[data-tab="editor"]').click();
  assert.match(await page.locator('#promptPreview').inputValue(),/artist:anmi/,'加入画风 inserts the artist into the prompt');
  const artistBackup=(await call('/api/export')).data;
  assert.deepEqual(artistBackup.artistPreferences,[{artist:'anmi',favorite:true,note:'星空方案，线条与色彩待比较。'}]);
  for(const secret of [token,secondToken,rbqToken])assert.ok(!JSON.stringify(artistBackup).includes(secret));
  await call('/api/artists/profile',{artist:'anmi',favorite:false,note:'临时改动'},'PUT');
  await page.locator('[data-tab="artists"]').click();
  await page.locator('#importFile').setInputFiles({name:'artist-backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(artistBackup))});
  await page.getByText('备份已导入，包含 1 位画师的收藏和备注。',{exact:true}).waitFor();
  await libraryCard('anmi').getByRole('button',{name:'取消收藏 anmi',exact:true}).waitFor();
  await libraryCard('anmi').getByRole('button',{name:'查看 anmi 的资料与例图',exact:true}).click();
  assert.equal(await noteBox.inputValue(),'星空方案，线条与色彩待比较。','backup import restores the note');
  await page.evaluate(()=>globalThis.fixtureApp.emit('backButton'));
  await library.locator('.artist-library-card').first().waitFor();
  assert.equal(await libraryBack(),false,'on the list the library leaves back to the host');
  await page.evaluate(()=>globalThis.fixtureApp.emit('backButton'));
  assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('editor-tab-active')),true,'back from the artist list returns to the editor');
  await page.evaluate(()=>globalThis.fixtureApp.emit('backButton'));
  assert.equal(await page.evaluate(()=>globalThis.fixtureApp.minimized),1,'only the final back minimizes the app');
  // Resource packs are installed from Settings; the artist page then shows the data.
  const packSets=async()=>Object.fromEntries((await call('/api/artists/resources/sets')).data.sets.map(row=>[row.id,row.version]));
  await call('/api/artists/profile',{artist:'fixture_artist',favorite:true,note:'保留个人备注'},'PUT');
  await page.locator('#openSettingsButton').click();
  const resources=page.locator('.native-artist-resources'),resourceStatus=resources.locator('p[role="status"]');
  const resourceButton=name=>resources.getByRole('button',{name,exact:true});
  const statusStarts=async prefix=>{await page.waitForFunction(({prefix})=>document.querySelector('.native-artist-resources p[role="status"]')?.textContent.startsWith(prefix),{prefix});};
  await statusStarts('本机已安装 1 个资料包');
  await resourceButton('导入资料包').click();
  await statusStarts('已安装 1 位画师的 1 张例图及对应标注。 本机已安装 2 个资料包');
  assert.equal((await packSets())['pack-a'],'1');
  let importedResource=(await call('/api/artists/profile?artist=fixture_artist')).data.artist;
  assert.equal(importedResource.resourceSet.id,'pack-a');assert.equal(importedResource.note,'保留个人备注');assert.equal(importedResource.favorite,true);
  packMode='corrupt';
  await resourceButton('导入资料包').click();
  await statusStarts('资料包未安装，原有资料保持不变。');
  assert.equal((await packSets())['pack-a'],'1');assert.deepEqual(discardedPacks,['mock-pack-2']);
  packMode='cancel';await resourceButton('导入资料包').click();
  await statusStarts('已取消导入。');
  packMode='valid';
  await resources.getByRole('textbox',{name:'资料目录链接',exact:true}).fill('https://github.com/example/resources/releases/download/v1/catalog.json');
  await resourceButton('读取目录').click();
  await statusStarts('已读取资料目录（1 个资料包）。');
  const downloadAll=resources.locator('button.primary');
  assert.equal(await downloadAll.textContent(),'下载 1 个资料包（约 22.4 MB）');
  downloadMode='wait';
  await downloadAll.click();
  await statusStarts('正在下载第 1 / 1 个资料包（catalog-test-10）…');
  assert.equal(await resourceButton('导入资料包').isDisabled(),true);assert.equal(await resourceButton('读取目录').isDisabled(),true);
  assert.equal(await resources.locator('progress').isVisible(),true);
  await page.screenshot({path:path.join(temporary,'native-pack-progress.png'),fullPage:false});
  await resourceButton('取消').click();
  await statusStarts('已取消，已安装的资料包保持可用。');
  assert.equal((await packSets())['catalog-test-10'],undefined,'a cancelled download installs nothing');
  assert.equal(packDownloads.length,1);
  // Commit cannot be interrupted, and a stale cancel acknowledgement cannot affect a newer operation.
  downloadMode='valid';installBarrier=new Promise(resolve=>{resumeInstall=resolve;});
  await resourceButton('导入资料包').click();
  { const deadline=Date.now()+5000;let phase='';while((phase=(await call('/api/artists/resources/status')).data.phase)!=='install'&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));assert.equal(phase,'install','import reached the commit phase'); }
  resumeCancelAck();await page.waitForTimeout(80);
  assert.equal(await resourceButton('取消').isVisible(),true,'a late acknowledgement of the earlier cancel does not end this operation');
  await resourceButton('取消').click();
  assert.equal((await call('/api/artists/resources/cancel',{},'POST')).data.accepted,false,'commit cannot be interrupted halfway');
  resumeInstall();installBarrier=null;
  await statusStarts('已安装 1 位画师的 1 张例图及对应标注。');
  assert.equal((await packSets())['pack-a'],'3');
  packMode='catalog-mismatch';await downloadAll.click();
  await statusStarts('资料包未安装，已安装的资料保持可用。');
  assert.ok(discardedPacks.includes('mock-pack-4'));assert.equal((await packSets())['catalog-test-10'],undefined);assert.equal((await packSets())['pack-a'],'3');
  packMode='valid';await downloadAll.click();
  await statusStarts('已安装 1 个资料包。');
  assert.equal(await downloadAll.textContent(),'已是目录中的最新版本');assert.equal(await downloadAll.isDisabled(),true);
  assert.equal((await packSets())['catalog-test-10'],'catalog-v1');
  assert.equal((await call('/api/artists/profile?artist=catalog_artist')).data.artist.resourceSet.id,'catalog-test-10');
  assert.equal(packDownloads.length,3);for(const download of packDownloads)assert.ok(!JSON.stringify(download).includes(token)&&!JSON.stringify(download).includes(rbqToken));
  assert.equal(packDownloads.at(-1).sha256,'a'.repeat(64));assert.equal(packDownloads.at(-1).expectedVersion,'catalog-v1');
  // V5 例图 (0.6.5): its own section — read the catalog, see the size, download; the artist page
  // shows the picture in the 生成 group with its generation record; 删除 removes only these.
  const examples=page.locator('.native-example-images'),exampleButton=name=>examples.getByRole('button',{name,exact:true});
  const exampleStarts=async prefix=>{await page.waitForFunction(({prefix})=>document.querySelector('.native-example-images p[role="status"]')?.textContent.startsWith(prefix),{prefix});};
  await exampleStarts('还没有 V5 例图。');
  assert.equal(await exampleButton('删除').isVisible(),false);
  await exampleButton('读取例图目录').click();
  await exampleStarts('共 1 位画师、1 张例图。');
  await exampleButton('下载 1 个例图包（约 9.0 MB）').click();
  await exampleStarts('已安装 1 个例图包。 已安装 1 位画师的 1 张 V5 例图。');
  assert.equal(await exampleButton('已是最新版本').isDisabled(),true);
  const kinds=(await call('/api/artists/resources/sets')).data.sets.map(row=>row.kind);
  assert.deepEqual([kinds.filter(kind=>kind==='examples').length,kinds.filter(kind=>kind==='artists').length],[1,3],'the sets route tells the examples pack apart for the annotation section');
  const withV5=(await call('/api/artists/profile?artist=fixture_artist')).data.artist;
  assert.equal(withV5.resourceSet.id,'pack-a','the artist pack still owns the artist');
  const v5=withV5.examples.find(item=>item.sourceType==='generated');
  assert.equal(v5.model,'v5');assert.equal(v5.metadata.params.steps,28);assert.match(v5.previewUrl,/revision=mock-pack-[0-9]+/);
  await page.screenshot({path:path.join(temporary,'native-v5-examples.png'),fullPage:false});
  await exampleButton('删除').click();
  await exampleStarts('已删除 V5 例图。 还没有 V5 例图。');
  assert.equal((await call('/api/artists/profile?artist=fixture_artist')).data.artist.examples.some(item=>item.sourceType==='generated'),false);
  assert.equal((await packSets())['pack-a'],'3','removing the examples leaves the artist packs');
  // 画风数据 (0.5.0): one press reads the manifest and installs the verified file; a file that does not
  // decode is removed and never replaces the installed data.
  const style=page.locator('.native-style-pack'),styleButton=name=>style.getByRole('button',{name,exact:true});
  const styleStarts=async prefix=>{await page.waitForFunction(({prefix})=>document.querySelector('.native-style-pack p[role="status"]')?.textContent.startsWith(prefix),{prefix});};
  await styleStarts('还没有画风数据');
  assert.equal(await styleButton('删除').isVisible(),false);
  styleMode='corrupt';await styleButton('下载画风数据').click();
  await styleStarts('画风数据未更新，原有数据保持不变。');
  assert.equal(styleDownloads.length,1,'the file was downloaded before it was rejected');
  assert.equal((await call('/api/artists/style-pack')).data.installed,null,'an undecodable file is not installed');
  assert.deepEqual(await fs.readdir(local('style-index')),[],'and is deleted');
  styleMode='valid';await styleButton('下载画风数据').click();
  await styleStarts('画风数据已安装。 已安装 fixture-1：2 位画师、3 张原作');
  const installedStyle=(await call('/api/artists/style-pack')).data.installed;
  assert.equal(installedStyle.sha256,styleFixture.sha256);assert.deepEqual((await fs.readdir(local('style-index'))).sort(),[`${styleFixture.sha256}.bin`,`${styleV5Fixture.sha256}.bin`,'installed.json'].sort());
  assert.equal(installedStyle.v5.sha256,styleV5Fixture.sha256,'the V5 index is installed with it');
  assert.match(await style.locator('p[role="status"]').innerText(),/V5 例图 2 张/);
  await styleButton('检查更新').click();
  await styleStarts('已是最新版本。');
  assert.equal(styleDownloads.length,3,'one corrupt try, then both files once; an up-to-date check downloads nothing');
  assert.equal(styleDownloads[2].url,styleV5Fixture.manifest.file.url);
  assert.equal(styleDownloads[0].url,styleFixture.manifest.file.url);assert.equal(styleDownloads[0].sha256,styleFixture.sha256);
  const styleInfo=(await call('/api/artists/style-index')).data;
  assert.equal(styleInfo.available,true);assert.deepEqual(styleInfo.chips.map(chip=>chip.id),['watercolor','gloomy']);
  const byFeel=(await call('/api/artists?vibe=watercolor')).data;
  assert.equal(byFeel.styleIndex,true);assert.equal(byFeel.styleRanked,true);
  assert.deepEqual(byFeel.artists.map(item=>item.artist),['fixture same image','anmi'],'only indexed artists, ranked by feel');
  assert.deepEqual(styleInfo.v5,{artists:2},'依据 is offered once the V5 index is installed');
  assert.deepEqual((await call('/api/artists?vibe=watercolor&source=v5')).data.artists.map(item=>item.artist),['anmi','fixture same image'],'V5 出图 ranks by the V5 samples');
  assert.deepEqual((await call('/api/artists?vibe=watercolor&source=originals')).data.artists.map(item=>item.artist),['fixture same image','anmi'],'原作 ranks by the originals');
  assert.deepEqual((await call('/api/artists/profile?artist=anmi')).data.artist.vibeTags,['暗调阴郁'],'the detail carries the vibe words');
  assert.equal((await call('/api/artists?like=anmi')).data.artists[0].artist,'fixture same image','找相似 answers locally');
  // 以图找画师 (0.6.0): the model is its own optional download; the list offers picture search only
  // once it is on the phone.
  assert.equal((await call('/api/artists')).data.imageSearch,false,'no model yet: no picture search');
  const modelSection=page.locator('.native-style-model'),modelButton=name=>modelSection.getByRole('button',{name,exact:true});
  const modelStarts=async prefix=>{await page.waitForFunction(({prefix})=>document.querySelector('.native-style-model p[role="status"]')?.textContent.startsWith(prefix),{prefix});};
  await modelStarts('还没有下载模型');
  await modelButton('下载模型').click();
  await modelStarts('模型已安装');
  assert.deepEqual(modelDownloads.map(item=>[item.url,item.sha256]),[[modelManifest.file.url,modelManifest.file.sha256]],'the checksum from the manifest goes to the native download');
  assert.equal(await modelButton('删除').isVisible(),true);
  assert.equal((await call('/api/artists')).data.imageSearch,true,'with the model, picture search is offered');
  await resources.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'resource settings fit the narrow viewport');
  await page.screenshot({path:path.join(temporary,'native-catalog-narrow.png'),fullPage:false});
  await page.setViewportSize({width:820,height:900});await resources.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(temporary,'native-catalog-wide.png'),fullPage:false});
  await page.locator('#closeSettingsButton').click();
  await page.locator('[data-tab="artists"]').click();
  // 0.7.1: 画风数据 older than this version's default (fixture-1) is offered as an update.
  await page.waitForFunction(()=>document.querySelector('.native-artist-notice:not([hidden]) p')?.textContent.startsWith('画风数据有更新'));
  await page.locator('.native-artist-notice').getByRole('button',{name:'以后再说',exact:true}).click();
  assert.equal(await page.locator('.native-artist-notice').isHidden(),true,'以后再说 hides the update notice');
  // The 画风 panel now offers the downloaded feel words, and choosing one re-ranks the cards.
  await library.locator('.artist-library-filter-toggle').click();
  await library.locator('[data-vibe-chip="watercolor"]').click();
  await page.waitForFunction(()=>document.querySelector('#artistLibraryMount .artist-library-card')?.dataset.artistCard==='fixture same image');
  await page.screenshot({path:path.join(temporary,'native-style-panel.png'),fullPage:false});
  await library.locator('.artist-library-clear').click();
  // The picture button in the search pill: choose a picture, rank by it, then remove it.
  await library.locator('.artist-library-filter-collapse').click();
  await library.locator('[data-image-search]:not([hidden])').waitFor();
  const chooser=page.waitForEvent('filechooser');
  await library.locator('[data-image-search]').click();
  await (await chooser).setFiles({name:'picture.png',mimeType:'image/png',buffer:png});
  await library.locator('[data-active-pill="image"]').waitFor();
  await page.waitForFunction(()=>document.querySelector('#artistLibraryMount .artist-library-card')?.dataset.artistCard==='fixture same image');
  assert.equal(embedCalls.length,1,'the picture was embedded once on the phone');
  await page.screenshot({path:path.join(temporary,'native-picture-search.png'),fullPage:false});
  await library.locator('[data-active-pill="image"]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-active-pill="image"]'));
  await library.locator('.artist-library-filter-toggle').click();
  await library.locator('.artist-library-filter-collapse').click();
  await searchBox.fill('fixture_artist');
  await libraryCard('fixture artist').getByRole('button',{name:'取消收藏 fixture artist',exact:true}).waitFor();
  await libraryCard('fixture artist').getByRole('button',{name:'查看 fixture artist 的资料与例图',exact:true}).click();
  await library.locator('.artist-library-example-image').first().scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>document.querySelector('#artistLibraryMount .artist-library-example-image')?.naturalWidth===2,{},{timeout:10000});
  await page.evaluate(()=>globalThis.fixtureApp.emit('backButton'));
  await searchBox.fill('catalog_artist');
  await libraryCard('catalog artist').waitFor();
  await page.reload();
  await page.waitForFunction(()=>globalThis.NAI_RUNTIME&&!document.querySelector('#appView').classList.contains('hidden'));
  assert.ok(recoveryCalls.length>=2,'startup reconciles from committed storage after a WebView reload');
  assert.ok(recoveryCalls.at(-1).includes('mock-pack-3'));
  assert.equal((await packSets())['pack-a'],'3');
  await fs.access(local('artist-resources/mock-pack-1/pack-example-preview.png'));
  await page.locator('[data-tab="artists"]').click();
  await library.locator('.artist-library-card').first().waitFor();
  assert.equal(await page.locator('[data-open-artist-rotation]:visible').count(),0,'public browsing does not expose private automation');
  // Annotation-only example: the thumbnail is fetched once from the Danbooru CDN through native HTTP, then served from the local cache.
  db.prepare('INSERT INTO artist_resource_examples(id,artist,position,source_url,width,height,note,metadata_json,thumb_ext,preview_ext) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('remote-fixture','anmi',9,'',2,2,'',JSON.stringify({remoteImages:{thumb:'https://cdn.donmai.us/360x360/ed/f8/edf829c359d0737baa2999ca09e3952c.jpg',preview:'https://cdn.donmai.us/720x720/ed/f8/edf829c359d0737baa2999ca09e3952c.webp'}}),'remote','remote');
  const remoteRead=()=>page.evaluate(async()=>{const response=await fetch('/api/artists/resources/image?id=remote-fixture&tier=thumb');return [response.status,response.headers.get('content-type'),(await response.arrayBuffer()).byteLength];});
  assert.deepEqual(await remoteRead(),[200,'image/jpeg',24]);assert.deepEqual(await remoteRead(),[200,'image/jpeg',24]);
  assert.deepEqual(danbooruCalls,['/360x360/ed/f8/edf829c359d0737baa2999ca09e3952c.jpg'],'second read comes from the local cache');
  await fs.access(local('artist-cache/remote-fixture-thumb.jpg'));
  // App update: the startup check asked GitHub once; WebView reloads within 12 hours did not ask again.
  assert.equal(githubCalls.length,1,'automatic update check is throttled to once per 12 hours');
  assert.equal(await page.locator('.native-update-toast').count(),0,'no toast without a newer release');
  await page.setViewportSize({width:360,height:800});
  await page.locator('#openSettingsButton').click();
  const updates=page.locator('#nativeAppUpdate'),updateButton=name=>updates.getByRole('button',{name,exact:true});
  const updateSays=async text=>{await page.waitForFunction(({text})=>document.querySelector('#nativeAppUpdate p[role="status"]')?.textContent===text,{text});};
  await updates.scrollIntoViewIfNeeded();
  assert.equal(await updates.locator('h2').textContent(),'应用更新');
  assert.equal(await updates.locator('.native-update-version').textContent(),`当前版本 ${appVersion}`);
  await updateButton('检查更新').click();
  await updateSays('已是最新版本');
  assert.equal(githubCalls.length,2);assert.equal(await updateButton('下载并安装').isVisible(),false);
  githubReleases=[releaseFixture(appVersion),releaseFixture(newerVersion)];
  await updateButton('检查更新').click();
  await updates.locator('.native-update-found').waitFor();
  assert.equal(await updates.locator('.native-update-found strong').textContent(),`发现新版本 ${newerVersion}`);
  assert.equal(await updates.locator('.native-update-title').textContent(),`NAI Pocket ${newerVersion} preview`);
  assert.equal(await updates.locator('.native-update-notes').textContent(),'本版\n新增 应用内更新\n修复若干问题','release notes: first three lines, plain text');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'update section fits a narrow phone');
  await page.screenshot({path:path.join(temporary,'native-update.png'),fullPage:false});
  await updateButton('下载并安装').click();
  await updateSays('请允许本应用「安装未知应用」，返回后点「安装」');
  assert.deepEqual(updateDownloads,[{url:`${releaseAssetBase}v${newerVersion}-preview/NAI-Pocket-v${newerVersion}-preview.apk`,sha256:'',sha256Url:`${releaseAssetBase}v${newerVersion}-preview/NAI-Pocket-v${newerVersion}-preview.apk.sha256`}]);
  await updateButton('安装').click();
  await updateSays('已打开系统安装程序');
  assert.equal(updateDownloads.length,1,'a downloaded package is installed without downloading again');
  assert.deepEqual(updateInstalls.map(item=>item.path),Array(2).fill('/data/user/0/app.naipocket.local/cache/updates/NAI-Pocket-update.apk'));
  await updateButton('忽略此版本').click();
  await updateSays(`已忽略 ${newerVersion}`);
  assert.equal(await updates.locator('.native-update-found').isVisible(),false);
  const updateState=key=>db.prepare('SELECT value FROM app_state WHERE key=?').get(key)?.value;
  { const deadline=Date.now()+3000;while(updateState('app_update_skipped')!==newerVersion&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50)); }
  assert.equal(updateState('app_update_skipped'),newerVersion,'the skipped version persists in native SQLite state');
  await page.locator('#closeSettingsButton').click();
  // Past the 12-hour window a skipped version stays quiet; a not-skipped one gets a one-line toast that opens Settings → 应用更新.
  db.prepare("UPDATE app_state SET value='0' WHERE key='app_update_last_check'").run();
  await page.reload();await page.waitForFunction(()=>globalThis.NAI_RUNTIME&&!document.querySelector('#appView').classList.contains('hidden'));
  { const deadline=Date.now()+5000;while(githubCalls.length<4&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50)); }
  assert.equal(githubCalls.length,4);await page.waitForTimeout(200);
  assert.equal(await page.locator('.native-update-toast').count(),0,'a skipped version is not announced');
  db.prepare("UPDATE app_state SET value='0' WHERE key='app_update_last_check'").run();db.prepare("DELETE FROM app_state WHERE key='app_update_skipped'").run();
  await page.reload();await page.waitForFunction(()=>globalThis.NAI_RUNTIME&&!document.querySelector('#appView').classList.contains('hidden'));
  const updateToast=page.locator('.native-update-toast');
  await updateToast.waitFor();await page.screenshot({path:path.join(temporary,'native-update-toast.png'),fullPage:false});
  assert.equal(await updateToast.locator('span').textContent(),`发现新版本 ${newerVersion}`);
  await updateToast.getByRole('button',{name:'查看',exact:true}).click();
  await updates.locator('.native-update-found').waitFor();
  assert.equal(await page.locator('#settingsDialog').evaluate(el=>el.open),true,'the toast opens Settings');
  assert.equal(await updateToast.count(),0);
  await page.locator('#closeSettingsButton').click();
  assert.equal(githubCalls.length,5);
  assert.deepEqual(errors,[]);
  console.log('Offline native wiring passed: UI token entry/rollback, dual-provider routing, Vibe consent/cache, gallery/export, public NAX preview, shared artist library (search/favourites/资料 notes/style filters/reload/Prompt insertion/backup import, no management), Settings resource packs (import/catalog/download/cancel/atomic commit), app update (12-hour throttle, check none/found, download/permission/install, skip, startup toast), native back through panels/detail/list and 360px layout. No upstream network used.');
  console.log(`Screenshot: ${path.join(temporary,'native-gallery.png')}`);
  }
} finally { if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));db.close(); }
}
