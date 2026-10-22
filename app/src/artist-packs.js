import { registerPlugin } from '@capacitor/core';

import { createArtistPackInstaller,validateArtistPackDownload,validateArtistResourceUrl } from '../../service/artist-pack.js';
import { validateArtistPackCatalog } from '../../service/artist-pack-catalog.js';
import { createArtistResourceStore } from '../../service/storage/artist-resources.js';

const native = registerPlugin('ArtistResources');
export function openArtistPacks(database) {
  const store=database.store(createArtistResourceStore(database.db,database.transaction));
  const installer=createArtistPackInstaller({store});
  let importing=false,cancelled=false,phase='idle',operationId='';
  async function run(method,args={}) {
      if(importing)throw Object.assign(new Error('已有资料包正在导入。'),{status:409});
      importing=true;cancelled=false;phase='native';operationId=crypto.randomUUID();let staged,committed=false;
      try {
        staged=await native[method]({...args,operationId});
        if(staged.cancelled)return {cancelled:true};
        if(cancelled){if(staged.directory)await native.discardPack({directory:staged.directory});staged=null;return {cancelled:true};}
        if(method==='readCatalog')return {catalog:validateArtistPackCatalog(staged.catalog,args.url)};
        phase='install';
        const result=await installer.install(staged,args);committed=true;
        // Retaining only releases the native staging handle; a late bridge error
        // must never delete images after SQLite has made this directory active.
        await native.retainPack({directory:staged.directory}).catch(()=>{});
        return result;
      } catch(error) {
        if(staged?.directory&&!committed)await native.discardPack({directory:staged.directory}).catch(()=>{});
        throw error;
      } finally {importing=false;phase='idle';}
  }
  return {
    // Called before mounting readers. Never sweep after a version switch while
    // an earlier reader can still hold an image path; native also gates reloads.
    recover:async()=>native.recover({activeDirectories:await store.activeDirectories()}),
    importPack:()=>run('importPack'),
    // V5 例图: one 删除 for every examples set; never while a pack is being installed.
    async removeExamples() {
      if(importing)throw Object.assign(new Error('已有资料包正在导入。'),{status:409});
      return store.removeExamples();
    },
    downloadPack:input=>run('downloadPack',validateArtistPackDownload(input)),
    readCatalog:input=>run('readCatalog',{url:validateArtistResourceUrl(input?.url,'json')}),
    async status() {
      if(!importing)return {busy:false,phase:'idle',cancellable:false};
      return phase==='install'?{busy:true,phase:'install',cancellable:false}:{...(await native.status()),busy:true};
    },
    async cancel() {
      if(!importing||phase==='install')return {accepted:false};
      cancelled=true;await native.cancelPack({operationId});return {accepted:true};
    }
  };
}
