import fs from 'node:fs/promises';
import path from 'node:path';
const app = path.resolve(import.meta.dirname, '..');
export async function writeLicenses(out, inputs) {
  const sections = [];
  for (const name of (await fs.readdir(path.join(app, 'licenses'))).sort()) {
    sections.push(`=== ${name} ===\n\n${await fs.readFile(path.join(app,'licenses',name),'utf8')}`);
  }
  sections.push(`=== Pako 3.0.2 ===\n\n${await fs.readFile(path.join(app,'../public/vendor/pako-LICENSE.txt'),'utf8')}`);
  const packages = new Set(['@capacitor/android']);
  for (const input of inputs) {
    const match = input.match(/^node_modules\/(@[^/]+\/[^/]+|[^/]+)\//); if (match) packages.add(match[1]);
  }
  for (const name of [...packages].sort()) {
    const directory = path.join(app,'node_modules',name), metadata = JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8'));
    const files = (await fs.readdir(directory)).filter(file => /^(LICENSE|COPYING)(\.|$)/i.test(file));
    if (!files.length) throw new Error(`Missing license file for runtime package ${name}`);
    for (const file of files) sections.push(`=== ${name} ${metadata.version} (${metadata.license || 'see notice'}) ===\n\n${await fs.readFile(path.join(directory,file),'utf8')}`);
  }
  await fs.writeFile(path.join(out,'licenses.txt'), sections.join('\n\n')+'\n');
}
