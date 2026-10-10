export function createSearchCacheStore(db) { return {
 get: key => db.prepare('SELECT response_json,expires_at FROM danbooru_cache WHERE cache_key=?').get(key),
 remove: key => db.prepare('DELETE FROM danbooru_cache WHERE cache_key=?').run(key),
 write: (key,type,json,expires,now) => db.prepare('INSERT INTO danbooru_cache(cache_key,cache_type,response_json,expires_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET response_json=excluded.response_json,expires_at=excluded.expires_at,updated_at=excluded.updated_at').run(key,type,json,expires,now)
}; }
