import { flow } from '../port-flow.js';

// Verified staged files are immutable; one transaction switches all metadata.
export function createArtistResourceStore(db, transaction) {
  return {
    activeDirectories: flow(function* () {
      // Include sets without profiles and legacy sets without a directory mapping.
      const rows=yield db.prepare(`SELECT directory FROM artist_resource_storage UNION
        SELECT s.id AS directory FROM artist_resource_sets s WHERE NOT EXISTS
        (SELECT 1 FROM artist_resource_storage d WHERE d.set_id=s.id)`).all();
      return rows.map(row=>row.directory);
    }),
    catalog: flow(function* () {
      const sets = yield db.prepare('SELECT id,version,title,synthetic FROM artist_resource_sets ORDER BY id').all();
      const profiles = yield db.prepare(`SELECT p.*, COALESCE(s.directory,p.set_id) AS storage_id, COUNT(DISTINCT e.id) AS example_count,
        COUNT(DISTINCT o.example_id) AS annotated_count,
        COUNT(DISTINCT CASE WHEN o.reviewed=1 THEN o.example_id END) AS reviewed_count,
        (SELECT id FROM artist_resource_examples WHERE artist=p.artist ORDER BY position,id LIMIT 1) AS cover_id
        FROM artist_resource_profiles p LEFT JOIN artist_resource_storage s ON s.set_id=p.set_id
        LEFT JOIN artist_resource_examples e ON e.artist=p.artist
        LEFT JOIN artist_resource_observations o ON o.example_id=e.id GROUP BY p.artist`).all();
      return { sets, profiles };
    }),
    profile: flow(function* (artist) {
      const profile = yield db.prepare(`SELECT p.*,s.version,s.title,s.synthetic,COALESCE(d.directory,p.set_id) AS storage_id FROM artist_resource_profiles p
        JOIN artist_resource_sets s ON s.id=p.set_id LEFT JOIN artist_resource_storage d ON d.set_id=p.set_id WHERE p.artist=?`).get(artist);
      if (!profile) return null;
      const examples = yield db.prepare('SELECT * FROM artist_resource_examples WHERE artist=? ORDER BY position,id').all(artist);
      const observations = yield db.prepare(`SELECT o.* FROM artist_resource_observations o
        JOIN artist_resource_examples e ON e.id=o.example_id WHERE e.artist=? ORDER BY e.position,o.id`).all(artist);
      return { profile, examples, observations };
    }),
    // Keep all pages within ONE serialized native store command. Paging at the
    // service layer would allow a pack replacement to interleave between pages.
    
    scanEvidence: flow(function* (visit, {confirmedOnly=false,signal}={}) {
      let after='';
      for(;;) {
        signal?.throwIfAborted();
        const rows=yield db.prepare(`SELECT o.id,e.artist,o.example_id,o.reviewed,o.source,o.facets_json,o.attributes_json
          FROM artist_resource_observations o JOIN artist_resource_examples e ON e.id=o.example_id
          WHERE o.id>? AND (o.reviewed=1 OR (?=0 AND o.source IN ('assistant-visual','danbooru-tags')))
          ORDER BY o.id LIMIT 256`).all(after,confirmedOnly?1:0);
        signal?.throwIfAborted();
        if(!rows.length)return;
        visit(rows);after=rows.at(-1).id;
        if(rows.length<256)return;
      }
    }),
    image: flow(function* (id) {
      return yield db.prepare(`SELECT e.id,e.thumb_ext,e.preview_ext,p.set_id,COALESCE(s.directory,p.set_id) AS storage_id
        FROM artist_resource_examples e JOIN artist_resource_profiles p ON p.artist=e.artist
        LEFT JOIN artist_resource_storage s ON s.set_id=p.set_id WHERE e.id=?`).get(id);
    }),
    install: flow(function* (pack,directory) {
      return yield transaction(function* () {
        if(yield db.prepare('SELECT set_id FROM artist_resource_storage WHERE directory=?').get(directory))throw Object.assign(new Error('安装目录已被使用，未覆盖现有资料。'),{status:409});
        for(const artist of pack.artists) {
          const owner=yield db.prepare('SELECT set_id FROM artist_resource_profiles WHERE artist=?').get(artist.artist);
          if(owner&&owner.set_id!==pack.id)throw Object.assign(new Error('画师已属于另一资料包，未覆盖现有资料。'),{status:409});
        }
        const old=yield db.prepare('SELECT directory FROM artist_resource_storage WHERE set_id=?').get(pack.id);
        // Explicit deletes work consistently even when a host's FK pragma differs.
        yield db.prepare(`DELETE FROM artist_resource_observations WHERE example_id IN (SELECT e.id FROM artist_resource_examples e
          JOIN artist_resource_profiles p ON p.artist=e.artist WHERE p.set_id=?)`).run(pack.id);
        yield db.prepare('DELETE FROM artist_resource_examples WHERE artist IN (SELECT artist FROM artist_resource_profiles WHERE set_id=?)').run(pack.id);
        yield db.prepare('DELETE FROM artist_resource_profiles WHERE set_id=?').run(pack.id);
        yield db.prepare('DELETE FROM artist_resource_storage WHERE set_id=?').run(pack.id);
        yield db.prepare(`INSERT INTO artist_resource_sets(id,version,title,synthetic) VALUES (?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET version=excluded.version,title=excluded.title,synthetic=excluded.synthetic`).run(pack.id,pack.version,pack.title,pack.synthetic?1:0);
        yield db.prepare('INSERT INTO artist_resource_storage(set_id,directory) VALUES (?,?)').run(pack.id,directory);
        for(const artist of pack.artists) {
          yield db.prepare('INSERT INTO artist_resource_profiles(artist,display_name,aliases_json,set_id) VALUES (?,?,?,?)').run(artist.artist,artist.displayName,JSON.stringify(artist.aliases),pack.id);
          for(const [position,example] of artist.examples.entries()) {
            yield db.prepare(`INSERT INTO artist_resource_examples(id,artist,position,source_url,width,height,note,metadata_json,thumb_ext,preview_ext)
              VALUES (?,?,?,?,?,?,?,?,?,?)`).run(example.id,artist.artist,position,example.sourceUrl,example.width,example.height,example.note,JSON.stringify(example.metadata),example.images.thumb.ext,example.images.preview.ext);
            for(const item of example.observations)yield db.prepare(`INSERT INTO artist_resource_observations(id,example_id,model,facets_json,attributes_json,note,schema_version,source,reviewed,provenance_json,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(item.id,item.exampleId,item.model,JSON.stringify(item.facets),JSON.stringify(item.attributes),item.note,item.schemaVersion,item.source,item.reviewed?1:0,JSON.stringify(item.provenance),item.updatedAt);
          }
        }
        return {previousDirectory:old?.directory||null};
      });
    })
  };
}
