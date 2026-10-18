// Shared app tables. Owner sessions, collection and automation stay in the Node schema.
export const APP_SCHEMA = `CREATE TABLE IF NOT EXISTS schemes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      data_json TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      cover_image_id TEXT
    );

CREATE TABLE IF NOT EXISTS snippets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','cancelled')),
      request_json TEXT NOT NULL,
      seed INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      image_id TEXT,
      initiated_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    );

CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at, position);

CREATE INDEX IF NOT EXISTS idx_jobs_batch ON jobs(batch_id, position);

CREATE INDEX IF NOT EXISTS idx_jobs_completed_cursor ON jobs(status, finished_at, id);

CREATE TABLE IF NOT EXISTS job_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info' CHECK(level IN ('info','warn','error')),
      phase TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL,
      detail_json TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );

CREATE INDEX IF NOT EXISTS idx_job_logs_job_id ON job_logs(job_id, id DESC);

CREATE TABLE IF NOT EXISTS input_assets (
      id TEXT PRIMARY KEY,
      stored_name TEXT NOT NULL,
      original_name TEXT NOT NULL DEFAULT '',
      mime TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

CREATE INDEX IF NOT EXISTS idx_input_assets_created ON input_assets(created_at DESC);

CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE,
      batch_id TEXT NOT NULL,
      original_name TEXT NOT NULL,
      thumb_name TEXT NOT NULL,
      preview_name TEXT NOT NULL DEFAULT '',
      mime TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      bytes INTEGER NOT NULL,
      thumb_bytes INTEGER NOT NULL,
      preview_bytes INTEGER NOT NULL DEFAULT 0,
      prompt TEXT NOT NULL,
      negative_prompt TEXT NOT NULL,
      params_json TEXT NOT NULL,
      seed INTEGER NOT NULL,
      favorite INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'gallery',
      FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );

CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at DESC);

-- 回收站 (1.8.4): a deleted picture's whole row, kept with its files for a day so it can be restored.
CREATE TABLE IF NOT EXISTS image_trash (
      id TEXT PRIMARY KEY,
      row_json TEXT NOT NULL,
      thumb_name TEXT NOT NULL DEFAULT '',
      bytes INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER NOT NULL
    );

CREATE INDEX IF NOT EXISTS idx_image_trash_deleted ON image_trash(deleted_at);

CREATE INDEX IF NOT EXISTS idx_images_favorite ON images(favorite, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_images_cursor ON images(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_images_favorite_cursor ON images(favorite, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS tag_translations (
      source_text TEXT NOT NULL,
      source_lang TEXT NOT NULL,
      target_lang TEXT NOT NULL,
      translated_text TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'cache',
      is_manual INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(source_text, source_lang, target_lang)
    );

CREATE INDEX IF NOT EXISTS idx_tag_translations_target ON tag_translations(target_lang, translated_text);

CREATE TABLE IF NOT EXISTS danbooru_cache (
      cache_key TEXT PRIMARY KEY,
      cache_type TEXT NOT NULL,
      response_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE INDEX IF NOT EXISTS idx_danbooru_cache_expires ON danbooru_cache(expires_at);

CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

CREATE TABLE IF NOT EXISTS artist_preferences (
      artist TEXT PRIMARY KEY,
      favorite INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );

-- Prepared, replaceable resources are separate from the user's preferences.
CREATE TABLE IF NOT EXISTS artist_resource_sets (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      title TEXT NOT NULL,
      synthetic INTEGER NOT NULL DEFAULT 0
    );
CREATE TABLE IF NOT EXISTS artist_resource_storage (
      set_id TEXT PRIMARY KEY REFERENCES artist_resource_sets(id) ON DELETE CASCADE,
      directory TEXT NOT NULL UNIQUE
    );
CREATE TABLE IF NOT EXISTS artist_resource_profiles (
      artist TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      set_id TEXT NOT NULL REFERENCES artist_resource_sets(id) ON DELETE CASCADE
    );
CREATE TABLE IF NOT EXISTS artist_resource_examples (
      id TEXT PRIMARY KEY,
      artist TEXT NOT NULL REFERENCES artist_resource_profiles(artist) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      source_url TEXT NOT NULL DEFAULT '',
      width INTEGER,
      height INTEGER,
      note TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      thumb_ext TEXT NOT NULL DEFAULT 'webp',
      preview_ext TEXT NOT NULL DEFAULT 'webp'
    );
CREATE INDEX IF NOT EXISTS idx_artist_resources_artist ON artist_resource_examples(artist, position, id);
CREATE TABLE IF NOT EXISTS artist_resource_observations (
      id TEXT PRIMARY KEY,
      example_id TEXT NOT NULL REFERENCES artist_resource_examples(id) ON DELETE CASCADE,
      model TEXT NOT NULL DEFAULT '',
      facets_json TEXT NOT NULL DEFAULT '{}',
      attributes_json TEXT NOT NULL DEFAULT '{}',
      note TEXT NOT NULL DEFAULT '',
      schema_version INTEGER NOT NULL,
      source TEXT NOT NULL,
      reviewed INTEGER NOT NULL DEFAULT 0,
      provenance_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER
    );
CREATE INDEX IF NOT EXISTS idx_artist_resources_observations ON artist_resource_observations(example_id);
`;
