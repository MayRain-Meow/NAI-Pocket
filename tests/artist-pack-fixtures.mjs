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
