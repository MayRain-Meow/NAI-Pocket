import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { APP_SCHEMA } from '../../service/storage/schema.js';
import { ARTIST_DANBOORU_STATS_SCHEMA } from '../../service/storage/artist-danbooru-stats.js';
import { runSteps } from '../../service/port-flow.js';

export async function openDatabase() {
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  const connection = await sqlite.createConnection('nai-pocket', false, 'no-encryption', 1, false);
  await connection.open();
  await connection.execute(APP_SCHEMA);
  await connection.execute(ARTIST_DANBOORU_STATS_SCHEMA);
  let tail = Promise.resolve();
  const serial = work => {
    const result = tail.then(work); tail = result.catch(() => {}); return result;
  };
  const db = {
    prepare(sql) {
      const values = args => args.map(value => value === undefined ? null : value);
      return {
        all: async (...args) => (await connection.query(sql, values(args))).values || [],
        get: async (...args) => (await connection.query(sql, values(args))).values?.[0],
        run: async (...args) => ({ changes: (await connection.run(sql, values(args), false)).changes?.changes || 0 })
      };
    }
  };
  async function transaction(program) {
    await connection.beginTransaction();
    try { const result = await runSteps(program()); await connection.commitTransaction(); return result; }
    catch (error) { try { await connection.rollbackTransaction(); } catch {} throw error; }
  }
  const store = commands => Object.fromEntries(Object.entries(commands).map(([name, command]) => [name, (...args) => serial(() => command(...args))]));
  return { db, transaction, store, serial, connection };
}
