import { flow } from '../port-flow.js';
// Concrete SQLite commands for the portable translation service.
export function createTranslationStore(db) {
  return {
    read: flow(function* (text, source, target) {
      return (yield db.prepare(`SELECT translated_text,provider,is_manual,updated_at FROM tag_translations
        WHERE source_text=? COLLATE NOCASE AND source_lang=? AND target_lang=?`).get(text, source, target));
    }),

    write: flow(function* ({ text, source, target, translated, provider, manual, replaceManual, now }) {
      (yield db.prepare(`INSERT INTO tag_translations(source_text,source_lang,target_lang,translated_text,provider,is_manual,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(source_text,source_lang,target_lang) DO UPDATE SET
        translated_text=excluded.translated_text, provider=excluded.provider,
        is_manual=CASE WHEN ?=1 THEN excluded.is_manual WHEN tag_translations.is_manual=1 AND excluded.is_manual=0 THEN 1 ELSE excluded.is_manual END,
        updated_at=excluded.updated_at`).run(text, source, target, translated, provider, manual ? 1 : 0, now, now, Number(replaceManual)));
    }),

    recordPublic: flow(function* (entries, provider, now) {
      const insert = db.prepare(`INSERT INTO tag_translations(source_text,source_lang,target_lang,translated_text,provider,is_manual,created_at,updated_at)
        VALUES (?,'en','zh-CN',?,?,0,?,?) ON CONFLICT(source_text,source_lang,target_lang) DO UPDATE SET
        translated_text=excluded.translated_text, provider=excluded.provider, updated_at=excluded.updated_at
        WHERE tag_translations.is_manual=0 AND tag_translations.provider NOT IN ('manual','builtin')`);
      let written = 0;
      for (const item of entries) written += Number((yield insert.run(item.tag, item.name, provider, now, now)).changes);
      return written;
    }),

    suggest: flow(function* (prefix, contains, limit) {
      return (yield db.prepare(`SELECT source_text AS tag,translated_text AS translation,is_manual,provider FROM tag_translations
        WHERE source_lang='en' AND target_lang='zh-CN'
          AND (source_text LIKE ? ESCAPE '\\' OR source_text LIKE ? ESCAPE '\\' OR translated_text LIKE ? ESCAPE '\\')
        ORDER BY is_manual DESC,(source_text LIKE ? ESCAPE '\\') DESC,length(source_text),source_text LIMIT ?`)
        .all(prefix, contains, contains, prefix, limit));
    }),

    searchChinese: flow(function* (value, limit) {
      return (yield db.prepare(`SELECT source_text AS tag,translated_text AS translation,is_manual,updated_at FROM tag_translations
        WHERE source_lang='en' AND target_lang='zh-CN' AND translated_text LIKE ? ESCAPE '\\'
        ORDER BY is_manual DESC,updated_at DESC LIMIT ?`).all(value, limit));
    }),

    counts: flow(function* (provider) {
      const row = (yield db.prepare('SELECT COUNT(*) AS count, SUM(is_manual) AS manual FROM tag_translations').get());
      const glossary = (yield db.prepare('SELECT COUNT(*) AS count FROM tag_translations WHERE provider=?').get(provider));
      return { row, glossary };
    })
  };
}
