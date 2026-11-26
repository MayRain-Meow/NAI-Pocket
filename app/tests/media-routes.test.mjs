import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const app = path.resolve(import.meta.dirname, '..');
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-media-routes-'));
const executable = name => process.env.JAVA_HOME
  ? path.join(process.env.JAVA_HOME, 'bin', name + (process.platform === 'win32' ? '.exe' : ''))
  : name;
function run(name, args) {
  const result = spawnSync(executable(name), args, { cwd: app, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name} failed with status ${result.status}`);
}
try {
  run('javac', ['-d', output,
    'android/app/src/main/java/app/naipocket/local/PocketMediaRoutes.java',
    'tests/PocketMediaRoutesTest.java']);
  run('java', ['-cp', output, 'app.naipocket.local.PocketMediaRoutesTest']);
} finally {
  await fs.rm(output, { recursive: true, force: true });
}
