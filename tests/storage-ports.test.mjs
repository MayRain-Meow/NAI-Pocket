import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { APP_SCHEMA } from '../service/storage/schema.js';
import { createSchemesStore } from '../service/storage/schemes.js';
import { runSteps } from '../service/port-flow.js';

const database = new DatabaseSync(':memory:');
database.exec(APP_SCHEMA);
const asyncDb = { prepare(sql) {
  const statement = database.prepare(sql);
  return Object.fromEntries(['all', 'get', 'run'].map(method => [method, async (...values) => statement[method](...values)]));
} };
const transaction = async program => {
  database.exec('BEGIN');
  try { const result = await runSteps(program()); database.exec('COMMIT'); return result; }
  catch (error) { database.exec('ROLLBACK'); throw error; }
};
let id = 0;
const ports = { now: () => 1, nextId: () => `id-${++id}` };
try {
  const store = createSchemesStore(asyncDb, transaction);
  await store.createScheme({ name: 'first', data: {}, makeDefault: true }, ports);
  await store.createScheme({ name: 'second', data: {}, makeDefault: true }, ports);
  let rows = await store.listSchemes();
  assert.deepEqual(rows.map(row => [row.name, row.is_default]), [['second', 1], ['first', 0]]);
  const first = rows.find(row => row.name === 'first');
  await assert.rejects(store.updateScheme({ id: first.id, row: first, name: 'second', data: {}, makeDefault: true }, ports), /UNIQUE/);
  rows = await store.listSchemes();
  assert.equal(rows.find(row => row.name === 'second').is_default, 1, 'failed rename rolls back the default reset across async calls');
  assert.equal(rows.find(row => row.name === 'first').is_default, 0);
  let synchronous = false;
  const result = runSteps((function* () { yield 1; synchronous = true; return 2; })());
  assert.equal(synchronous, true); assert.equal(result, 2, 'Node transaction callback stays synchronous');
  console.log('storage ports: async commands/defaults/rollback and synchronous Node completion passed');
} finally { database.close(); }
