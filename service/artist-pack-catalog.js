import { normalizeArtistIdentity } from '../public/artist-index-v5.js';
import { ARTIST_PACK_LIMITS,validateArtistResourceUrl } from './artist-pack.js';


export const ARTIST_CATALOG_BYTES=2*1024*1024;
const requireValue=(ok,message)=>{if(!ok)throw Object.assign(new Error(message),{status:400});};
const label=(value,max)=>typeof value==='string'&&value.trim()&&value.length<=max;
const integer=(value,max)=>Number.isSafeInteger(value)&&value>=0&&value<=max;
const counts=['artists','examples','annotatedExamples','manualReviewedExamples','aiInitialObservations'];
function coverage(value,maxArtists) {
  const result={};
  for(const key of counts){requireValue(integer(value?.[key],maxArtists*32),'目录中的资料数量无效。');result[key]=value[key];}
  requireValue(result.artists>0&&result.artists<=maxArtists&&result.examples<=result.artists*4
    &&result.annotatedExamples<=result.examples&&result.manualReviewedExamples<=result.annotatedExamples
    &&result.aiInitialObservations<=result.examples*8,'目录中的资料数量不一致。');
  result.artistsByExampleCount={};let artists=0,examples=0;
  for(let n=0;n<=4;n++) {
    const count=value.artistsByExampleCount?.[n];requireValue(integer(count,maxArtists),'目录中的例图覆盖数量无效。');
    result.artistsByExampleCount[n]=count;artists+=count;examples+=count*n;
  }
  requireValue(artists===result.artists&&examples===result.examples,'目录中的例图覆盖数量不一致。');return result;
}
export function validateArtistPackCatalog(input,sourceUrl) {
  const url=validateArtistResourceUrl(sourceUrl,'json');
  requireValue(new TextEncoder().encode(JSON.stringify(input)).byteLength<=ARTIST_CATALOG_BYTES,'资料目录过大。');
  requireValue(input?.format==='nai-pocket-artist-catalog'&&input.formatVersion===1
    &&input.partition==='sha256-normalized-name-byte0-and63-v1','不支持的画师资料目录版本。');
  requireValue(typeof input.id==='string'&&/^[A-Za-z0-9_-]{1,90}$/.test(input.id)
    &&label(input.version,100)&&label(input.title,200)&&typeof input.synthetic==='boolean','资料目录身份无效。');
  requireValue(Array.isArray(input.shards)&&input.shards.length>0&&input.shards.length<=64,'目录分包数量无效。');
  requireValue(input.kind===undefined||['artists','examples'].includes(input.kind),'不支持的资料目录类型。');
  const catalog={id:input.id,kind:input.kind??'artists',version:input.version,title:input.title,synthetic:input.synthetic,url,
    ...coverage(input,64*ARTIST_PACK_LIMITS.artists),shards:[]};
  const ids=new Set(),artists=new Set();
  for(const row of input.shards) {
    requireValue(typeof row?.id==='string'&&row.id.startsWith(input.id+'-')&&/^[0-3][a-f0-9]$/.test(row.id.slice(input.id.length+1))
      &&!ids.has(row.id)&&row.file===row.id+'.zip'&&row.version===input.version,'目录分包身份无效或重复。');ids.add(row.id);
    requireValue(integer(row.bytes,ARTIST_PACK_LIMITS.totalBytes)&&row.bytes>0&&typeof row.sha256==='string'&&/^[a-f0-9]{64}$/.test(row.sha256),'目录分包容量或校验值无效。');
    const info=coverage(row,ARTIST_PACK_LIMITS.artists);
    requireValue(Array.isArray(row.artistNames)&&row.artistNames.length===info.artists,'目录中的画师名单不完整。');
    const artistNames=row.artistNames.map(name=>{
      const identity=typeof name==='string'?normalizeArtistIdentity(name):'';
      requireValue(label(name,180)&&identity&&identity.length<=160&&!/[\u0000-\u001f]|:\/\//.test(name)&&!artists.has(identity),'目录中的画师名无效或重复。');
      artists.add(identity);return name;
    });
    catalog.shards.push({id:row.id,version:row.version,bytes:row.bytes,sha256:row.sha256,artistNames,...info,
      url:validateArtistResourceUrl(new URL(row.file,url).href),expectedId:row.id,expectedVersion:row.version});
  }
  for(const key of counts)requireValue(catalog.shards.reduce((sum,row)=>sum+row[key],0)===catalog[key],'目录汇总与各分包不一致。');
  for(let n=0;n<=4;n++)requireValue(catalog.shards.reduce((sum,row)=>sum+row.artistsByExampleCount[n],0)===catalog.artistsByExampleCount[n],'目录覆盖汇总与各分包不一致。');
  return catalog;
}
