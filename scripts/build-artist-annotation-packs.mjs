// Builds annotation-only artist packs: names, per-image style annotations and a
// pointer to each public Danbooru CDN rendition. No image bytes are packaged.
// Only general/sensitive (g/s) examples are kept; q/e examples and their
// annotations are dropped entirely. Local output only; nothing is uploaded.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeArtistIdentity } from '../public/artist-index-v5.js';
import { validateArtistPack, validateRemoteImageUrl } from '../service/artist-pack.js';
import { artistShard, fields, scan, finishArtistShards, writeArtistPackOutput } from './build-artist-packs.mjs';

export const ANNOTATION_PACK_VERSION='2026-10-10-annotations-gs-1';
export const ANNOTATION_PACK_TITLE='画师逐图标注（不含图片）';
export const ANNOTATION_RATINGS=Object.freeze(['g','s']);
const fail=message=>{throw new Error(message);};
const PREVIEW_TYPES=['720x720','sample','360x360','180x180'];

// Danbooru CDN layout: /<variant>/<md5[0:2]>/<md5[2:4]>/<md5>.<ext>; "sample"
// renditions carry a "sample-" filename prefix. Every post has a 360x360 JPEG.
export function danbooruRemoteImages(metadata) {
  const md5=metadata?.remoteMd5,variant=metadata?.variant;
  if(metadata?.provider!=='Danbooru'||typeof md5!=='string'||!/^[0-9a-f]{32}$/.test(md5))return null;
  if(!variant||!PREVIEW_TYPES.includes(variant.type)||!['jpg','png','webp'].includes(variant.fileExt))return null;
  const folder=`${md5.slice(0,2)}/${md5.slice(2,4)}`;
  try {
    return {thumb:validateRemoteImageUrl(`https://cdn.donmai.us/360x360/${folder}/${md5}.jpg`),
      preview:validateRemoteImageUrl(`https://cdn.donmai.us/${variant.type}/${folder}/${variant.type==='sample'?'sample-':''}${md5}.${variant.fileExt}`)};
  } catch {return null;}
}

export async function prepareArtistAnnotations({sourceFile,version=ANNOTATION_PACK_VERSION,title=ANNOTATION_PACK_TITLE}) {
  const sourcePath=path.resolve(sourceFile);
  if((await fs.stat(sourcePath)).size>128*1024*1024)fail('Prepared source exceeds 128 MiB');
  const input=JSON.parse(await fs.readFile(sourcePath,'utf8'));
  fields(input,['format','formatVersion','id','version','title','synthetic','artists'],'Collection');
  if(input.format!=='nai-pocket-artist-collection'||input.formatVersion!==1||typeof input.id!=='string'||!/^[A-Za-z0-9_-]{1,90}$/.test(input.id)||!Array.isArray(input.artists)||!input.artists.length)fail('Invalid prepared artist collection');
  const source={id:input.id,version,title,synthetic:input.synthetic===true};
  const stats={inputArtists:input.artists.length,inputExamples:0,keptExamples:0,droppedByRating:{},droppedWithoutRemote:0,droppedObservations:0,artistsWithoutKeptExamples:0};
  const buckets=new Map(),identities=new Set(),exampleIds=new Set(),observationIds=new Set(),artists=[];
  for(const row of input.artists) {
    fields(row,['artist','aliases','examples'],'Artist');
    const identity=normalizeArtistIdentity(row.artist);
    if(identities.has(identity))fail('Duplicate normalized artist identity');identities.add(identity);
    if(!Array.isArray(row.examples)||row.examples.length>4)fail('Expected zero to four retained originals per artist');
    const artist={artist:row.artist,aliases:structuredClone(row.aliases??[]),examples:[]};
    for(const example of row.examples) {
      fields(example,['id','sourceType','sourceUrl','width','height','note','metadata','images','remoteImages','observations'],'Example');
      if(exampleIds.has(example.id))fail('Duplicate example ID across collection');exampleIds.add(example.id);
      stats.inputExamples++;
      const observations=example.observations??[];
      for(const item of observations) {
        fields(item,['id','exampleId','model','schemaVersion','attributes','facets','note','reviewed','source','provenance','updatedAt'],'Observation');
        if(observationIds.has(item.id))fail('Duplicate observation ID across collection');observationIds.add(item.id);
        if(item.source==='assistant-visual'&&item.reviewed===true)fail('Automatic observations must not be marked manually reviewed');
      }
      const rating=example.metadata?.rating;
      if(!ANNOTATION_RATINGS.includes(rating)) {
        // Excluded entirely: no pointer, metadata or annotation text survives.
        const key=typeof rating==='string'?rating:'missing';stats.droppedByRating[key]=(stats.droppedByRating[key]||0)+1;
        stats.droppedObservations+=observations.length;continue;
      }
      const remoteImages=danbooruRemoteImages(example.metadata);
      if(!remoteImages){stats.droppedWithoutRemote++;stats.droppedObservations+=observations.length;continue;}
      artist.examples.push({id:example.id,sourceType:example.sourceType,sourceUrl:example.sourceUrl,width:example.width,height:example.height,
        note:example.note??'',metadata:structuredClone(example.metadata),remoteImages,observations:structuredClone(observations)});
      stats.keptExamples++;
    }
    // Artists whose examples were all excluded stay listed by name only.
    if(!artist.examples.length)stats.artistsWithoutKeptExamples++;
    artists.push(artist);
    const shard=artistShard(identity),manifest={format:'nai-pocket-artist-pack',formatVersion:1,id:`${source.id}-${shard}`,version:source.version,title:source.title,synthetic:source.synthetic,artists:[artist]};
    validateArtistPack(manifest);
    if(!buckets.has(shard))buckets.set(shard,{...manifest,artists:[]});buckets.get(shard).artists.push(artist);
  }
  // Scan exactly what will be published (excluded examples never reach output).
  scan({...source,artists});
  const packs=finishArtistShards(buckets);
  for(const pack of packs)if(pack.files.length)fail('Annotation-only packs must not contain image files');
  return {source,packs,stats};
}

export async function buildArtistAnnotationPacks({sourceFile,outputDirectory,version,title}) {
  const {source,packs,stats}=await prepareArtistAnnotations({sourceFile,version,title});
  const catalog=await writeArtistPackOutput({source,packs,imageRoot:null,outputDirectory});
  return {catalog,stats};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const [sourceFile,outputDirectory,version,...extra]=process.argv.slice(2);
  if(!sourceFile||!outputDirectory||extra.length)throw new Error('Usage: node scripts/build-artist-annotation-packs.mjs <prepared.json> <new-output-directory> [version]');
  const {catalog,stats}=await buildArtistAnnotationPacks({sourceFile,outputDirectory,version});
  console.log(JSON.stringify(stats));
  console.log(`Prepared ${catalog.shards.length} annotation-only packs: ${catalog.artists} artists, ${catalog.examples} g/s examples (remote images), ${catalog.annotatedExamples} annotated. Local output only; nothing uploaded.`);
}
