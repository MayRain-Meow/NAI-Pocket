import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const release = process.argv[2] === 'release';
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run(process.execPath, ['scripts/build.mjs']);
run(process.execPath, ['node_modules/@capacitor/cli/bin/capacitor', 'sync', 'android']);
// Release signing variables must not be retained by a reusable Gradle daemon.
const gradleArgs = [release ? 'assembleRelease' : 'assembleDebug', '--console=plain', ...(release ? ['--no-daemon'] : [])];
if (process.platform === 'win32') run(process.env.ComSpec || 'C:/Windows/System32/cmd.exe', ['/d', '/s', '/c', `gradlew.bat ${gradleArgs.join(' ')}`], path.join(root, 'android'));
else run('sh', ['./gradlew', ...gradleArgs], path.join(root, 'android'));
