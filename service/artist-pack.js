import { normalizeArtistIdentity } from '../public/artist-index-v5.js';
import { validateStyleAttributes } from '../public/artist-style-schema.js';

export const ARTIST_PACK_LIMITS = Object.freeze({ manifestBytes:8*1024*1024, totalBytes:256*1024*1024, imageBytes:4*1024*1024, artists:2000, examples:8000, files:16000 });
const fail = message => Object.assign(new Error(message), { status:400 });
const check = (condition,message) => { if(!condition)throw fail(message); };
const id = value => typeof value==='string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const string = (value,max,label) => {check(typeof value==='string'&&value.length<=max,`${label}格式无效。`);return value;};
const object = value => value && typeof value==='object' && !Array.isArray(value);
export function validateArtistResourceUrl(value,extension='zip') {
  try {
    check(typeof value==='string'&&value.length<=2048,'下载链接无效。');
    const url=new URL(value.trim());
    check(url.protocol==='https:'&&url.hostname==='github.com'&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash
      &&/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/(?:download\/[^/]+\/[^/]+|latest\/download\/[^/]+)$/u.test(url.pathname)
      &&decodeURIComponent(url.pathname).toLowerCase().endsWith('.'+extension),`请填写 GitHub Release 的 ${extension.toUpperCase()} 下载链接。`);
    return url.href;
  } catch(error) {if(error.status)throw error;throw fail('请填写有效的 GitHub Release 下载链接。');}
}
export function validateArtistPackDownload(input) {
    const url=validateArtistResourceUrl(input?.url);
    const sha256=input.sha256??'';check(typeof sha256==='string'&&(!sha256||/^[a-f0-9]{64}$/.test(sha256)),'资料包校验值无效。');
    const expectedId=input.expectedId,expectedVersion=input.expectedVersion;
    if(expectedId!==undefined||expectedVersion!==undefined) {
      check(id(expectedId)&&typeof expectedVersion==='string'&&expectedVersion.trim()&&expectedVersion.length<=100&&sha256,'目录中的资料包身份无效。');
      return {url,sha256,expectedId,expectedVersion};
    }
    return {url,sha256};
}
// Annotation-only packs point at a public Danbooru CDN rendition instead of
// carrying image bytes. Only this exact host/path shape is ever fetched.
const REMOTE_IMAGE_PATH=/^\/(?:180x180|360x360|720x720|sample)\/[0-9a-f]{2}\/[0-9a-f]{2}\/(?:sample-)?[0-9a-f]{32}\.(?:jpg|png|webp)$/;
export function validateRemoteImageUrl(value) {
  let url;
  try {url=typeof value==='string'&&value.length<=300?new URL(value):null;} catch {url=null;}
  check(url&&url.href===value&&url.protocol==='https:'&&url.hostname==='cdn.donmai.us'&&!url.port&&!url.username&&!url.password
    &&!url.search&&!url.hash&&!value.includes('?')&&!value.includes('#')&&REMOTE_IMAGE_PATH.test(url.pathname),'在线例图地址无效。');
  return url.href;
}
export const remoteImageExtension=value=>validateRemoteImageUrl(value).split('.').at(-1);
function jsonObject(value,max,label) {
  check(object(value),`${label}格式无效。`);
  check(JSON.stringify(value).length<=max,`${label}过大。`);
  return structuredClone(value);
}
function sourceUrl(value) {
  if(value==null||value==='')return '';
  try {const url=new URL(string(value,2000,'作品来源'));check(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password,'作品来源无效。');return url.href;}
  catch {throw fail('作品来源无效。');}
}


const GENERATED_MODELS=['v3','v4','v4.5','v5'];
export function validateArtistPack(input) {
  check(object(input)&&input.format==='nai-pocket-artist-pack'&&input.formatVersion===1,'不支持的画师资料包版本。');
  check(id(input.id),'资料包 ID 无效。');
  check(input.synthetic===undefined||typeof input.synthetic==='boolean','演示资料标记无效。');
  // 'examples' packs (0.6.5): generated example pictures attached to artists by name. They own no
  // artist (any pack, or none, may describe the artist) and carry no annotations. Older apps refuse
  // them at the sourceType check below, so a mixed-up download never half-installs.
  check(input.kind===undefined||['artists','examples'].includes(input.kind),'不支持的资料包类型。');
  const kind=input.kind??'artists',generated=kind==='examples';
  const pack={id:input.id,kind,version:string(input.version,100,'资料版本'),title:string(input.title,200,'资料标题'),synthetic:input.synthetic===true,artists:[],files:[]};
  check(pack.version.trim()&&pack.title.trim(),'资料版本和标题不能为空。');
  check(Array.isArray(input.artists)&&input.artists.length>0&&input.artists.length<=ARTIST_PACK_LIMITS.artists,'资料包画师数量无效。');
  const names=new Set(),examples=new Set(),observations=new Set();let total=0;
  for(const row of input.artists) {
    const name=string(row?.artist,180,'画师名称'),key=normalizeArtistIdentity(name);
    check(key&&key.length<=160&&!/[\u0000-\u001f]|:\/\//.test(name)&&!names.has(key),'画师名称无效或重复。');names.add(key);
    const aliases=row.aliases??[];check(Array.isArray(aliases)&&aliases.length<=40,'画师别名无效。');
    const artist={artist:key,displayName:name,aliases:aliases.map(alias=>string(alias,180,'画师别名')),examples:[]};
    check(Array.isArray(row.examples)&&row.examples.length<=4&&(!generated||row.examples.length>0),'每位画师最多四张原作例图。');
    for(const sample of row.examples) {
      check(object(sample)&&id(sample.id)&&!examples.has(sample.id),'例图 ID 无效或重复。');examples.add(sample.id);
      check(examples.size<=ARTIST_PACK_LIMITS.examples,'资料包例图过多。');
      if(generated)check(sample.sourceType==='generated'&&GENERATED_MODELS.includes(sample.model)&&sample.remoteImages===undefined&&!sample.observations?.length,'例图包只能包含生成图。');
      else check(sample.sourceType==='original','资料包只能包含原作例图。');
      check(Number.isSafeInteger(sample.width)&&sample.width>0&&Number.isSafeInteger(sample.height)&&sample.height>0,'例图尺寸无效。');
      const example={id:sample.id,...(generated?{model:sample.model}:{}),sourceUrl:sourceUrl(sample.sourceUrl),width:sample.width,height:sample.height,note:string(sample.note??'',4000,'例图备注'),metadata:jsonObject(sample.metadata??{},16000,'例图来源数据'),observations:[]};
      const remote=sample.remoteImages!==undefined;
      check(remote!==(sample.images!==undefined),'例图必须且只能包含本地图片或在线图片地址之一。');
      if(remote) {
        check(object(sample.remoteImages)&&Object.keys(sample.remoteImages).every(key=>['thumb','preview'].includes(key)),'在线例图描述无效。');
        example.remoteImages={thumb:validateRemoteImageUrl(sample.remoteImages.thumb),preview:validateRemoteImageUrl(sample.remoteImages.preview)};
      } else example.images={};
      for(const tier of remote?[]:['thumb','preview']) {
        const image=sample.images?.[tier];check(object(image)&&['webp','png','jpg'].includes(image.ext),'例图文件描述无效。');
        const name=`${sample.id}-${tier}.${image.ext}`;
        check(image.name===name&&/^[a-f0-9]{64}$/.test(image.sha256),'例图文件名或校验值无效。');
        check(Number.isSafeInteger(image.bytes)&&image.bytes>0&&image.bytes<=ARTIST_PACK_LIMITS.imageBytes,'例图文件大小无效。');
        total+=image.bytes;check(total<=ARTIST_PACK_LIMITS.totalBytes,'资料包超过安装容量上限。');
        const file={name,ext:image.ext,bytes:image.bytes,sha256:image.sha256};example.images[tier]=file;pack.files.push(file);
      }
      const entries=sample.observations??[];check(Array.isArray(entries)&&entries.length<=8,'每张例图的标注数量无效。');
      for(const entry of entries) {
        check(object(entry)&&id(entry.id)&&!observations.has(entry.id)&&entry.exampleId===sample.id,'标注 ID 重复或与例图不对应。');observations.add(entry.id);
        check([1,2].includes(entry.schemaVersion),'不支持的标注版本。');
        check(typeof entry.reviewed==='boolean'&&['manual','assistant-visual','danbooru-tags'].includes(entry.source),'标注来源或确认状态无效。');
        check(entry.updatedAt==null||(Number.isSafeInteger(entry.updatedAt)&&entry.updatedAt>=0),'标注时间无效。');
        let attributes;try{attributes=validateStyleAttributes(entry.attributes??{});}catch{throw fail('包含未知的标注属性。');}
        example.observations.push({id:entry.id,exampleId:sample.id,model:string(entry.model??'',100,'标注模型'),schemaVersion:entry.schemaVersion,
          attributes,facets:jsonObject(entry.facets??{},4000,'旧版标注'),note:string(entry.note??'',12000,'标注说明'),
          reviewed:entry.reviewed,source:entry.source,provenance:jsonObject(entry.provenance??{},16000,'标注来源'),updatedAt:entry.updatedAt??null});
      }
      artist.examples.push(example);
    }
    pack.artists.push(artist);
  }
  return pack;
}

export function createArtistPackInstaller({store}) {
  return {
    async install(staged,expected={}) {
      check(id(staged?.directory),'资料包暂存目录无效。');
      check(new TextEncoder().encode(JSON.stringify(staged.manifest)).byteLength<=ARTIST_PACK_LIMITS.manifestBytes,'资料清单过大。');
      const pack=validateArtistPack(staged.manifest);
      check((expected.expectedId===undefined||pack.id===expected.expectedId)&&(expected.expectedVersion===undefined||pack.version===expected.expectedVersion),'下载的资料包与目录中的身份或版本不一致，未安装。');
      check(Array.isArray(staged.files)&&staged.files.length===pack.files.length,'资料包文件不完整或包含额外文件。');
      const actual=new Map();
      for(const file of staged.files){check(!actual.has(file.name),'资料包包含重复文件。');actual.set(file.name,file);}
      for(const expected of pack.files) {
        const file=actual.get(expected.name);
        check(file&&file.bytes===expected.bytes&&file.sha256===expected.sha256,'资料包图片校验失败，原资料保持不变。');
        check(file.mime===`image/${expected.ext==='jpg'?'jpeg':expected.ext}`&&Number.isSafeInteger(file.width)&&Number.isSafeInteger(file.height)
          &&file.width>0&&file.height>0&&Math.max(file.width,file.height)<=10000&&file.width*file.height<=32000000,'资料包图片格式或尺寸无效。');
      }
      const result=await store.install(pack,staged.directory);
      return {installed:true,id:pack.id,version:pack.version,artists:pack.artists.length,examples:pack.artists.reduce((sum,artist)=>sum+artist.examples.length,0),...result};
    }
  };
}
