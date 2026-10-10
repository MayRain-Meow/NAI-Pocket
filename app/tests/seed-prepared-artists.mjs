// Preview only: selected source files stay outside the repository and APK.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {prepareArtistCollection,readPreparedArtistImage} from '../../scripts/build-artist-packs.mjs';
import {createArtistPackInstaller} from '../../service/artist-pack.js';
import {createArtistResourceStore} from '../../service/storage/artist-resources.js';
import {runSteps} from '../../service/port-flow.js';

export async function seedPreparedArtists({db,dataRoot,sourceFile,imageDirectory}) {
  const {source,packs,imageRoot}=await prepareArtistCollection({sourceFile,imageDirectory});
  const transaction=program=>{db.exec('BEGIN');try{const result=runSteps(program());db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}};
  const installer=createArtistPackInstaller({store:createArtistResourceStore(db,transaction)});
  let examples=0,annotatedExamples=0;
  for(const pack of packs) {
    const directory=randomUUID(),folder=path.resolve(dataRoot,'artist-resources',directory);
    await fs.mkdir(folder,{recursive:true});const files=[];
    for(const expected of pack.files) {
      const actual=await readPreparedArtistImage(imageRoot,expected.name);
      if(actual.sha256!==expected.sha256||actual.bytes.length!==expected.bytes)throw new Error('Prepared source changed before preview installation');
      await fs.writeFile(path.join(folder,expected.name),actual.bytes,{flag:'wx'});
      files.push({name:expected.name,bytes:actual.bytes.length,sha256:actual.sha256,mime:actual.mime,width:actual.width,height:actual.height});
    }
    const installed=await installer.install({directory,manifest:pack.manifest,files});examples+=installed.examples;
    annotatedExamples+=pack.manifest.artists.reduce((sum,row)=>sum+row.examples.filter(example=>example.observations.length).length,0);
  }
  return {artists:source.artists.length,examples,annotatedExamples,synthetic:source.synthetic===true,names:source.artists.map(row=>row.artist),title:source.title};
}
