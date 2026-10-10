// Focused synthetic UI/host check; no GitHub download or generation request.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { catalogFixture } from './artist-pack-fixtures.mjs';
import { DEFAULT_ARTIST_CATALOG_URL, withArtistCatalogSource } from '../app/src/artist-resource-source.js';

const source = { resources: { installed: false, sets: [], artists: 0 }, artists: [] }, forwarded = [];
const get = () => 'unchanged';
const service = withArtistCatalogSource({ get, async list(...args) { forwarded.push(args); return source; } });
const signal = new AbortController().signal, result = await service.list({ q: 'artist' }, { signal });
assert.equal(result.resources.defaultCatalogUrl, DEFAULT_ARTIST_CATALOG_URL);
assert.equal(service.get, get); assert.equal(forwarded[0][1].signal, signal);
assert.equal(source.resources.defaultCatalogUrl, undefined, 'host metadata does not mutate the shared service result');

if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to Playwright index.mjs.');
const { chromium } = await import(pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)));
const root = path.resolve(import.meta.dirname, '..'), fixture = catalogFixture().catalog;
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Artist default source fixture</title>
<link rel="stylesheet" href="/public/artist-browser.css"><style>*{box-sizing:border-box}body{font-family:sans-serif;margin:8px;background:#111;color:#eee}button,input{font:inherit}</style></head>
<body><main id="mount"></main><script type="module">
import { createArtistBrowser } from '/public/artist-browser.js';
import { withArtistCatalogSource } from '/app/src/artist-resource-source.js';
import { validateArtistPackCatalog } from '/service/artist-pack-catalog.js';
const rawCatalog=${JSON.stringify(fixture)};
const profile={artist:'Catalog_Artist',favorite:false,note:'',indexed:false,aliases:[],examples:[],observations:[],exampleCount:0,annotatedCount:0};
const plain={async list(){return {artists:[profile],total:1,page:1,pages:1,favorites:0,resources:{installed:false,sets:[],artists:0}};}};
const artists=new URL(location.href).searchParams.has('no-default')?plain:withArtistCatalogSource(plain);
window.fixture={calls:[],errors:[],mode:'ok'};
const api=async(url,options={})=>{
 const pathname=new URL(url,location.origin).pathname;
 if(pathname==='/api/artists')return artists.list();
 if(pathname==='/api/artists/profile')return {artist:profile};
 if(pathname==='/api/artists/resources/status')return {busy:false};
 fixture.calls.push({pathname,body:options.body});
 if(pathname==='/api/artists/resources/catalog'){
  if(fixture.mode==='fail')throw new Error('Synthetic catalog unavailable');
  return {catalog:validateArtistPackCatalog(rawCatalog,options.body.url)};
 }
 if(pathname==='/api/artists/resources/download')return {artists:1,examples:1};
 if(pathname==='/api/artists/resources/import')return {cancelled:true};
 throw new Error('Unexpected fixture route: '+pathname);
};
window.reader=createArtistBrowser({api,mount:document.querySelector('#mount'),toast:message=>fixture.errors.push(message)});
await reader.show();window.ready=true;
</script></body></html>`;
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(html); }
  if (!/^\/(?:public|service|app\/src)\/[a-z0-9-]+\.(?:js|css)$/.test(pathname)) { response.statusCode=404; return response.end(); }
  try { const bytes=await fs.readFile(path.join(root,pathname.slice(1))); response.setHeader('Content-Type',pathname.endsWith('.css')?'text/css':'text/javascript'); response.end(bytes); }
  catch { response.statusCode=404; response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base=`http://127.0.0.1:${server.address().port}`, temporary=await fs.mkdtemp(path.join(os.tmpdir(),'nai-default-source-'));
let browser;
try {
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const context=await browser.newContext({viewport:{width:360,height:800}}), page=await context.newPage(), errors=[], external=[];
  page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==base){external.push(route.request().url());return route.abort();}return route.continue();});
  const ready=async(pathname='/')=>{await page.goto(base+pathname);await page.waitForFunction(()=>window.ready);};
  const calls=()=>page.evaluate(()=>fixture.calls);
  const openPacks=()=>page.locator('.artist-pack-download > summary').click();
  const card=page.locator('[data-pack-id="catalog-test-10"]');
  await ready();
  assert.equal(await page.locator('input[aria-label="资料目录链接"]').inputValue(),DEFAULT_ARTIST_CATALOG_URL);
  assert.deepEqual(await calls(),[],'browsing artist names makes no resource request');
  await openPacks();await card.waitFor();
  assert.deepEqual(await calls(),[{pathname:'/api/artists/resources/catalog',body:{url:DEFAULT_ARTIST_CATALOG_URL}}]);
  assert.equal(await page.evaluate(()=>localStorage.getItem('nai-artist-resource-catalog-url')),DEFAULT_ARTIST_CATALOG_URL);
  for(const width of [360,820]){
    await page.setViewportSize({width,height:800});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`default URL/catalog fit ${width}px`);
    await page.screenshot({path:path.join(temporary,`catalog-${width}.png`),fullPage:false});
  }
  await card.getByRole('button',{name:'下载并安装此包',exact:true}).click();
  await page.getByText('已安装 1 位画师的 1 张例图及对应标注。',{exact:true}).waitFor();
  const downloads=(await calls()).filter(item=>item.pathname.endsWith('/download'));
  assert.equal(downloads.length,1,'only an explicit pack click downloads a ZIP');
  assert.deepEqual(downloads[0].body,{url:DEFAULT_ARTIST_CATALOG_URL.replace('catalog.json','catalog-test-10.zip'),sha256:'a'.repeat(64),expectedId:'catalog-test-10',expectedVersion:'catalog-v1'});

  const custom='https://github.com/example/custom/releases/download/v1/catalog.json';
  await page.evaluate(url=>localStorage.setItem('nai-artist-resource-catalog-url',url),custom);
  await ready();await openPacks();await card.waitFor();
  assert.equal((await calls())[0].body.url,custom,'remembered custom source takes precedence over the app default');
  await page.getByRole('textbox',{name:'资料目录链接',exact:true}).fill('https://github.com/example/broken/releases/download/v1/catalog.json');
  await page.evaluate(()=>fixture.mode='fail');await page.getByRole('button',{name:'读取资料目录',exact:true}).click();
  await page.getByText('目录读取失败，原有目录和本机资料保持不变。',{exact:true}).waitFor();
  assert.equal(await card.count(),1,'failed source changes keep the last validated catalog');
  assert.equal(await page.evaluate(()=>localStorage.getItem('nai-artist-resource-catalog-url')),custom);
  await page.getByRole('button',{name:'导入资料包',exact:true}).click();await page.getByText('已取消导入。',{exact:true}).waitFor();
  assert.equal((await calls()).at(-1).pathname,'/api/artists/resources/import','local import remains available without a working network source');

  await page.evaluate(()=>localStorage.clear());await ready();
  await page.getByRole('button',{name:'资料',exact:true}).click();
  await page.getByRole('textbox',{name:'画师备注',exact:true}).fill('Unsaved personal note');
  await page.getByRole('button',{name:'查找资料包',exact:true}).click();await card.waitFor();
  assert.equal(await page.getByRole('searchbox',{name:'查找画师资料包',exact:true}).inputValue(),'Catalog_Artist');
  assert.equal((await calls()).length,1,'detail shortcut reads one catalog, never a whole collection');
  await page.getByRole('button',{name:'资料',exact:true}).click();
  assert.equal(await page.getByRole('textbox',{name:'画师备注',exact:true}).inputValue(),'Unsaved personal note');

  await page.evaluate(()=>localStorage.clear());await ready();await page.evaluate(()=>fixture.mode='fail');
  await openPacks();await page.getByText('目录读取失败，原有目录和本机资料保持不变。',{exact:true}).waitFor();
  await openPacks();await openPacks();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal((await calls()).length,1,'failed first-open reads are not retried on each panel toggle');
  assert.equal(await page.evaluate(()=>localStorage.getItem('nai-artist-resource-catalog-url')),null,'failed default reads are not remembered as validated');
  await page.evaluate(()=>fixture.mode='ok');await page.getByRole('button',{name:'读取资料目录',exact:true}).click();await card.waitFor();
  assert.equal((await calls()).length,2,'the explicit read button can retry after connectivity returns');

  await page.evaluate(()=>localStorage.clear());await ready('/?no-default');await openPacks();
  assert.deepEqual(await calls(),[],'hosts without a configured default keep explicit source selection');
  assert.equal(await page.getByRole('textbox',{name:'资料目录链接',exact:true}).inputValue(),'');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('Default source passed: native metadata, first-open index, explicit single-pack download, custom-source preservation, offline import, artist shortcut/draft and 360/820px bounds.');
  console.log('Screenshots: '+temporary);
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
