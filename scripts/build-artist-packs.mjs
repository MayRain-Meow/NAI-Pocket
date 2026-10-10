
// Builds local artifacts only. No database, credential, server or upload access.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { ARTIST_PACK_LIMITS as limits, validateArtistPack } from '../service/artist-pack.js';
import { normalizeArtistIdentity } from '../public/artist-index-v5.js';
import { detectImageMime, imageDimensionsFromBytes } from '../public/image-bytes.js';
import { validateArtistPackCatalog } from '../service/artist-pack-catalog.js';

const fail=message=>{throw new Error(message);};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const compare=(a,b)=>a<b?-1:a>b?1:0;
export const artistShard=artist=>(createHash('sha256').update(normalizeArtistIdentity(artist)).digest()[0]&63).toString(16).padStart(2,'0');
function fields(value,allowed,label) {
  if(!value||typeof value!=='object'||Array.isArray(value))fail(`${label}: expected an object`);
  if(Object.keys(value).some(key=>!allowed.includes(key)))fail(`${label}: unexpected field; prepare a selected public-data input`);
}
function scan(value,location='source') {
  if(typeof value==='string') {
    // A public source URL can legitimately contain /home/. Unix paths start
    // at a text boundary; credentials are still scanned throughout the value.
    if(/\bpst-[A-Za-z0-9_-]{35,}|\bsk-[A-Za-z0-9_-]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b[A-Z]:[\\/]|(?:^|[\s"'=:({\[])\/(?:app\/data|opt|home|root)\//i.test(value))fail(`${location}: possible private credential or local path (value suppressed)`);
  } else if(value&&typeof value==='object') {
    for(const [key,item] of Object.entries(value)) {
      if(/token|password|secret|credential|authorization|cookie|api[_-]?key|private[_-]?key/i.test(key))fail(`${location}: possible private field (value suppressed)`);
      scan(item,`${location}.${key}`);
    }
  }
}
export async function readPreparedArtistImage(root,name) {
  if(!/^[A-Za-z0-9_-]{1,100}-(?:thumb|preview)\.(?:png|jpg|webp)$/.test(name))fail('Image filename must be a flat example-ID/tier name');
  const file=path.join(root,name),info=await fs.lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||path.dirname(await fs.realpath(file))!==root)fail('Image path is not a direct regular file');
  if(info.size<1||info.size>limits.imageBytes)fail('Image exceeds the native file limit');
  const bytes=await fs.readFile(file);
  if(bytes.length!==info.size)fail('Image changed while reading');
  const mime=detectImageMime(bytes),dimensions=imageDimensionsFromBytes(bytes);
  if(mime!==`image/${name.endsWith('.jpg')?'jpeg':name.split('.').at(-1)}`||!dimensions||Math.max(dimensions.width,dimensions.height)>10000||dimensions.width*dimensions.height>32000000)fail('Invalid or oversized image');
  return {bytes,sha256:digest(bytes),crc:crc32(bytes),mime,...dimensions};
}

// Stored ZIP entries keep existing WebP bytes unchanged. Fixed headers produce
// identical archives from identical prepared inputs, independently of file dates.
async function writeZip(target,manifest,images,root) {
  const temporary=target+'.partial',handle=await fs.open(temporary,'wx'),hash=createHash('sha256');
  let offset=0;const central=[];
  async function write(bytes) {
    let written=0;while(written<bytes.length){const result=await handle.write(bytes,written,bytes.length-written);if(!result.bytesWritten)fail('ZIP write made no progress');written+=result.bytesWritten;}
    hash.update(bytes);offset+=bytes.length;if(offset>limits.totalBytes)fail('ZIP exceeds native archive limit');
  }
  async function entry(name,bytes,crc) {
    const encoded=Buffer.from(name),start=offset,local=Buffer.alloc(30),directory=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(33,12);
    local.writeUInt32LE(crc,14);local.writeUInt32LE(bytes.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(encoded.length,26);
    directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x800,8);directory.writeUInt16LE(33,14);
    directory.writeUInt32LE(crc,16);directory.writeUInt32LE(bytes.length,20);directory.writeUInt32LE(bytes.length,24);directory.writeUInt16LE(encoded.length,28);directory.writeUInt32LE(start,42);
    await write(local);await write(encoded);await write(bytes);central.push(directory,encoded);
  }
  try {
    await entry('manifest.json',manifest,crc32(manifest));
    for(const file of images) {
      const actual=await readPreparedArtistImage(root,file.name);
      if(actual.sha256!==file.sha256||actual.bytes.length!==file.bytes)fail('Source image changed after validation');
      await entry(file.name,actual.bytes,actual.crc);
    }
    const start=offset;for(const bytes of central)await write(bytes);
    const end=Buffer.alloc(22),count=images.length+1;end.writeUInt32LE(0x06054b50);end.writeUInt16LE(count,8);end.writeUInt16LE(count,10);end.writeUInt32LE(offset-start,12);end.writeUInt32LE(start,16);await write(end);
    await handle.sync();await handle.close();await fs.rename(temporary,target);
    return {bytes:offset,sha256:hash.digest('hex')};
  } catch(error) {await handle.close().catch(()=>{});await fs.unlink(temporary).catch(()=>{});throw error;}
}
function coverage(artists) {
  const examples=artists.flatMap(row=>row.examples),observations=examples.flatMap(row=>row.observations);
  return {artists:artists.length,examples:examples.length,annotatedExamples:examples.filter(row=>row.observations.length).length,
    manualReviewedExamples:examples.filter(row=>row.observations.some(item=>item.source==='manual'&&item.reviewed)).length,
    aiInitialObservations:observations.filter(row=>row.source==='assistant-visual'&&!row.reviewed).length,
    artistsByExampleCount:Object.fromEntries([0,1,2,3,4].map(count=>[count,artists.filter(row=>row.examples.length===count).length]))};
}
export async function prepareArtistCollection({sourceFile,imageDirectory}) {
  const sourcePath=path.resolve(sourceFile),imageRoot=await fs.realpath(imageDirectory);
  if((await fs.stat(sourcePath)).size>128*1024*1024)fail('Prepared source exceeds 128 MiB');
  const source=JSON.parse(await fs.readFile(sourcePath,'utf8'));
  fields(source,['format','formatVersion','id','version','title','synthetic','artists'],'Collection');
  if(source.format!=='nai-pocket-artist-collection'||source.formatVersion!==1||typeof source.id!=='string'||!/^[A-Za-z0-9_-]{1,90}$/.test(source.id)||!Array.isArray(source.artists)||!source.artists.length)fail('Invalid prepared artist collection');
  scan(source);
  const buckets=new Map(),identities=new Set(),exampleIds=new Set(),observationIds=new Set();
  for(const row of source.artists) {
    fields(row,['artist','aliases','examples'],'Artist');
    const identity=normalizeArtistIdentity(row.artist);
    if(identities.has(identity))fail('Duplicate normalized artist identity');identities.add(identity);
    if(!Array.isArray(row.examples)||row.examples.length>4)fail('Expected zero to four retained originals per artist');
    const artist=structuredClone(row);
    for(const example of artist.examples) {
      fields(example,['id','sourceType','sourceUrl','width','height','note','metadata','images','observations'],'Example');
      if(exampleIds.has(example.id))fail('Duplicate example ID across collection');exampleIds.add(example.id);
      fields(example.images,['thumb','preview'],'Images');
      for(const tier of ['thumb','preview']) {
        const image=example.images[tier];fields(image,['name','ext','bytes','sha256'],'Image');
        if(image.name!==`${example.id}-${tier}.${image.ext}`)fail('Image ID and filename differ');
        const actual=await readPreparedArtistImage(imageRoot,image.name);
        if((image.bytes!==undefined&&image.bytes!==actual.bytes.length)||(image.sha256!==undefined&&image.sha256!==actual.sha256))fail('Image differs from prepared transfer checksum');
        example.images[tier]={name:image.name,ext:image.ext,bytes:actual.bytes.length,sha256:actual.sha256};
      }
      for(const item of example.observations??[]) {
        fields(item,['id','exampleId','model','schemaVersion','attributes','facets','note','reviewed','source','provenance','updatedAt'],'Observation');
        if(observationIds.has(item.id))fail('Duplicate observation ID across collection');observationIds.add(item.id);
        if(item.source==='assistant-visual'&&item.reviewed===true)fail('Automatic observations must not be marked manually reviewed');
      }
      example.observations??=[];
    }
    const shard=artistShard(identity),manifest={format:'nai-pocket-artist-pack',formatVersion:1,id:`${source.id}-${shard}`,version:source.version,title:source.title,synthetic:source.synthetic,artists:[artist]};
    validateArtistPack(manifest);
    if(!buckets.has(shard))buckets.set(shard,{...manifest,artists:[]});buckets.get(shard).artists.push(artist);
  }
  const packs=[];
  for(const [shard,manifest] of [...buckets].sort(([a],[b])=>compare(a,b))) {
    manifest.artists.sort((a,b)=>compare(normalizeArtistIdentity(a.artist),normalizeArtistIdentity(b.artist)));
    const pack=validateArtistPack(manifest),bytes=Buffer.from(JSON.stringify(manifest));
    const extracted=bytes.length+pack.files.reduce((sum,file)=>sum+file.bytes,0);
    const zipBytes=extracted+22+[...pack.files,{name:'manifest.json'}].reduce((sum,file)=>sum+76+2*Buffer.byteLength(file.name),0);
    if(bytes.length>limits.manifestBytes||extracted>limits.totalBytes||zipBytes>limits.totalBytes)fail(`Shard ${shard} exceeds native limits; do not silently change published ownership`);
    packs.push({manifest,bytes,files:pack.files});
  }
  return {source,packs,imageRoot};
}
export async function buildArtistPacks({sourceFile,imageDirectory,outputDirectory}) {
  const output=path.resolve(outputDirectory),{source,packs,imageRoot}=await prepareArtistCollection({sourceFile,imageDirectory});
  // Refuse to overwrite prior output. The catalog is written last; failure leaves
  // an explicitly incomplete staging output for diagnosis, never a ready catalog.
  await fs.mkdir(output);
  const marker=path.join(output,'INCOMPLETE.json');await fs.writeFile(marker,JSON.stringify({complete:false,id:source.id,version:source.version}));
  const catalog={format:'nai-pocket-artist-catalog',formatVersion:1,id:source.id,version:source.version,title:source.title,synthetic:source.synthetic===true,
    partition:'sha256-normalized-name-byte0-and63-v1',...coverage(packs.flatMap(pack=>pack.manifest.artists)),shards:[]};
  for(const pack of packs) {
    const file=pack.manifest.id+'.zip',info=await writeZip(path.join(output,file),pack.bytes,pack.files,imageRoot);
    catalog.shards.push({id:pack.manifest.id,file,version:source.version,...info,...coverage(pack.manifest.artists),artistNames:pack.manifest.artists.map(row=>row.artist)});
  }
  const catalogPath=path.join(output,'catalog.json');
  validateArtistPackCatalog(catalog,'https://github.com/validation/resources/releases/download/local/catalog.json');
  await fs.writeFile(catalogPath+'.partial',JSON.stringify(catalog,null,2)+'\n',{flag:'wx'});
  await fs.unlink(marker);await fs.rename(catalogPath+'.partial',catalogPath);return catalog;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const [sourceFile,imageDirectory,outputDirectory,...extra]=process.argv.slice(2);
  if(!sourceFile||!imageDirectory||!outputDirectory||extra.length)throw new Error('Usage: node scripts/build-artist-packs.mjs <prepared.json> <image-directory> <new-output-directory>');
  const catalog=await buildArtistPacks({sourceFile,imageDirectory,outputDirectory});
  console.log(`Prepared ${catalog.shards.length} resource packs: ${catalog.artists} artists, ${catalog.examples} originals, ${catalog.annotatedExamples} annotated. Local output only; nothing uploaded.`);
}
