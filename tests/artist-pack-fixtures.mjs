import { createHash } from 'node:crypto';
import { makePngFixture } from './png-metadata-fixtures.mjs';

export function packFixture({version='one',directory='staged-one'}={}) {
  const buffer=makePngFixture({width:2,height:2,rgba:Buffer.alloc(16,255)}),sha256=createHash('sha256').update(buffer).digest('hex');
  const files=['thumb','preview'].map(tier=>({name:`pack-example-${tier}.png`,bytes:buffer.length,sha256,ext:'png',mime:'image/png',width:2,height:2}));
  return {directory,buffer,files,manifest:{format:'nai-pocket-artist-pack',formatVersion:1,id:'pack-a',version,title:'Synthetic import',synthetic:true,
    artists:[{artist:'Fixture_Artist',aliases:['测试别名'],examples:[{id:'pack-example',sourceType:'original',sourceUrl:'https://example.invalid/art',width:2,height:2,note:'合成测试图片',metadata:{},
      images:{thumb:{...files[0]},preview:{...files[1]}},observations:[{id:'pack-observation',exampleId:'pack-example',model:'original',schemaVersion:2,source:'assistant-visual',reviewed:false,note:'合成标注',attributes:{'line.weight':['fine']},provenance:{kind:'synthetic'},updatedAt:123}]}]}]}};
}

export function catalogFixture() {
  const staged=packFixture({version:'catalog-v1'}),sample=staged.manifest.artists[0].examples[0];
  staged.manifest.id='catalog-test-10';staged.manifest.artists[0].artist='Catalog_Artist';
  sample.id='catalog-example';sample.observations[0].id='catalog-observation';sample.observations[0].exampleId=sample.id;
  for(const [index,tier] of ['thumb','preview'].entries()){const name=`catalog-example-${tier}.png`;sample.images[tier].name=name;staged.files[index].name=name;}
  const coverage={artists:1,examples:1,annotatedExamples:1,manualReviewedExamples:0,aiInitialObservations:1,artistsByExampleCount:{0:0,1:1,2:0,3:0,4:0}};
  return {staged,catalog:{format:'nai-pocket-artist-catalog',formatVersion:1,id:'catalog-test',version:'catalog-v1',title:'原作例图与逐图标注 · 合成目录测试',synthetic:true,
    partition:'sha256-normalized-name-byte0-and63-v1',...coverage,shards:[{id:'catalog-test-10',file:'catalog-test-10.zip',version:'catalog-v1',bytes:23456789,sha256:'a'.repeat(64),artistNames:['Catalog_Artist'],...coverage}]}};
}

// Annotation-only pack: the example points at public Danbooru CDN renditions.
export const REMOTE_MD5='edf829c359d0737baa2999ca09e3952c';
export function remotePackFixture({version='remote-one',directory='remote-stage',id='pack-remote'}={}) {
  const staged=packFixture({version,directory}),example=staged.manifest.artists[0].examples[0];
  staged.manifest.id=id;staged.manifest.artists[0].artist='Remote_Artist';
  example.id='remote-example';example.observations[0].id='remote-observation';example.observations[0].exampleId=example.id;
  example.metadata={provider:'Danbooru',postId:1,rating:'g',remoteMd5:REMOTE_MD5,variant:{type:'720x720',width:2,height:2,fileExt:'webp'}};
  delete example.images;
  example.remoteImages={thumb:`https://cdn.donmai.us/360x360/ed/f8/${REMOTE_MD5}.jpg`,preview:`https://cdn.donmai.us/720x720/ed/f8/${REMOTE_MD5}.webp`};
  return {...staged,files:[]};
}

// V5 例图 (0.6.5): an examples pack attaching one generated picture to an artist by name.
export const EXAMPLE_RECORD=Object.freeze({prompt:'1.3::cowboy shot::, artist:fixture_artist, street',negativePrompt:'nsfw, lowres',seed:42,model:'nai-diffusion-5-full',
  params:{width:1024,height:1024,steps:28,scale:5,sampler:'k_dpmpp_2m_sde',noiseSchedule:'karras'}});
export function examplesPackFixture({id='v5-examples-1a',version='v5-one',directory='v5-stage-one',artist='Fixture_Artist',exampleId='v5-example'}={}) {
  const staged=packFixture({version,directory});
  const files=staged.files.map(file=>({...file,name:file.name.replace('pack-example',exampleId)}));
  return {directory,buffer:staged.buffer,files,manifest:{format:'nai-pocket-artist-pack',formatVersion:1,kind:'examples',id,version,title:'V5 例图',synthetic:false,
    artists:[{artist,examples:[{id:exampleId,sourceType:'generated',model:'v5',width:1024,height:1024,metadata:structuredClone(EXAMPLE_RECORD),
      images:{thumb:{...files[0]},preview:{...files[1]}}}]}]}};
}
export function examplesCatalogFixture() {
  const coverage={artists:1,examples:1,annotatedExamples:0,manualReviewedExamples:0,aiInitialObservations:0,artistsByExampleCount:{0:0,1:1,2:0,3:0,4:0}};
  return {format:'nai-pocket-artist-catalog',formatVersion:1,id:'v5-examples',kind:'examples',version:'v5-one',title:'NovelAI V5 画师例图',synthetic:false,
    partition:'sha256-normalized-name-byte0-and63-v1',...coverage,shards:[{id:'v5-examples-1a',file:'v5-examples-1a.zip',version:'v5-one',bytes:9437184,sha256:'b'.repeat(64),artistNames:['Fixture_Artist'],...coverage}]};
}
