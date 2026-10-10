import { normalizeArtistIdentity } from '../public/artist-index-v5.js';

// Synthetic metadata only. These statements never open or modify owner data.
export function seedArtistResources(db) {
  db.prepare('INSERT INTO artist_resource_sets(id,version,title,synthetic) VALUES (?,?,?,1)').run('fixture-v1','demo-1','三图与标注体验资料');
  const files=[];
  function artist(name,alias=[]) {
    db.prepare('INSERT INTO artist_resource_profiles(artist,display_name,aliases_json,set_id) VALUES (?,?,?,?)').run(normalizeArtistIdentity(name),name,JSON.stringify(alias),'fixture-v1');
  }
  function example(artist,id,position,{attributes,reviewed=false,source='assistant-visual',note='',absent=false}={}) {
    db.prepare(`INSERT INTO artist_resource_examples(id,artist,position,source_url,width,height,note,metadata_json,thumb_ext,preview_ext)
      VALUES (?,?,?,?,512,768,?,'{}','png','png')`).run(id,normalizeArtistIdentity(artist),position,`https://example.invalid/works/${id}`,'合成测试图，不是画师原作。');
    if(attributes)db.prepare(`INSERT INTO artist_resource_observations(id,example_id,model,attributes_json,note,schema_version,source,reviewed,provenance_json,updated_at)
      VALUES (?,?,?,?,?,2,?,?,?,123)`).run(`obs-${id}`,id,'original',JSON.stringify(attributes),note,source,reviewed?1:0,JSON.stringify({kind:'synthetic-fixture',exampleId:id}));
    if(!absent)for(const tier of ['thumb','preview'])files.push({path:`artist-resources/fixture-v1/${id}-${tier}.png`,position});
  }
  artist('anmi',['合成别名']);
  example('anmi','fixture-anmi-1',1,{attributes:{'line.weight':['fine'],'palette.temperature':['cool']},note:'合成标注 A：这张例图的纤细线条与冷色调。'});
  example('anmi','fixture-anmi-2',2,{attributes:{'line.weight':['bold'],'palette.temperature':['warm'],'coloring.technique':['flat']},reviewed:true,source:'manual',note:'合成标注 B：粗重线条、暖色调与平涂。'});
  example('anmi','fixture-anmi-3',3);
  artist('fixture_same_image');
  example('fixture_same_image','fixture-same-1',1,{attributes:{'line.weight':['fine'],'palette.temperature':['warm']},note:'同一观察满足两个条件。'});
  artist('fixture_no_image');
  example('fixture_no_image','fixture-missing-1',1,{attributes:{'line.weight':['fine']},absent:true,note:'元数据已到达，图片文件缺失。'});
  return files;
}
