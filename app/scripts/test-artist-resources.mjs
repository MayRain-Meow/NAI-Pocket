import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),output=await fs.mkdtemp(path.join(os.tmpdir(),'nai-artist-java-'));
const executable=name=>process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin',name+(process.platform==='win32'?'.exe':'')):name;
function run(name,args){const result=spawnSync(executable(name),args,{cwd:root,stdio:'inherit'});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status||1);}
const classes=['ArtistPackArchive','ArtistPackDownload','ArtistPackMaintenance'];
run('javac',['-d',output,...classes.map(name=>`android/app/src/main/java/app/naipocket/local/${name}.java`),...classes.map(name=>`tests/${name}Test.java`)]);
for(const name of classes)run('java',['-cp',output,`app.naipocket.local.${name}Test`]);
console.log(`JVM test classes: ${output}`);
