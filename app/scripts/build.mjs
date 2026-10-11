import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { publicCss, publicHtml } from './public-assets.mjs';
import { writeLicenses } from './licenses.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), project = path.dirname(root);
const out = path.join(root, 'www');
if (path.resolve(out) !== path.resolve(root, 'www') || path.dirname(out) !== root) throw new Error('Invalid generated output directory');
await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
const result = await build({ absWorkingDir: root, entryPoints: ['src/main.js'], outdir: out, bundle: true, format: 'esm', target: 'chrome110',
  splitting: true, metafile: true, minify: false, sourcemap: false, legalComments: 'none', chunkNames: 'chunks/[name]-[hash]',
  plugins: [{ name: 'shared-ui-boundaries', setup(build) {
    build.onResolve({ filter: /owner-features\.js(?:\?|$)/ }, () => ({ path: path.join(root, 'src/owner-features.js') }));
    build.onResolve({ filter: /\.js\?v=/ }, args => ({ path: path.resolve(args.resolveDir, args.path.split('?')[0]) }));
  } }] });
// Build inputs are the export boundary; private modules must not slip into a bundle.
// The artist-library UI and its catalog/list helpers are public (owner decision 2026-10-10);
// the collection, annotation and mirror tools behind it are not.
const forbidden = /(?:artist-automation|deepseek|artist-ingestion|artist-annotation|nax-preview-mirror|customer-relay|src[\/]artist-library)/i;
const forbiddenInputs = Object.keys(result.metafile.inputs).filter(input => forbidden.test(input));
if (forbiddenInputs.length) throw new Error(`Private modules entered native build: ${forbiddenInputs.join(', ')}`);
for (const name of ['styles.css','workspace.css','tag-chips.css','artist-browser.css','artist-library.css']) await fs.writeFile(path.join(out,name),publicCss(await fs.readFile(path.join(project,'public',name),'utf8')));
await fs.copyFile(path.join(root,'src/native.css'),path.join(out,'native.css'));
await fs.mkdir(path.join(out,'icons'),{recursive:true});
for (const name of ['icon-flow-192.png','icon-flow-512.png','apple-touch-icon.png']) await fs.copyFile(path.join(project,'public/icons',name),path.join(out,'icons',name));
const html = publicHtml(await fs.readFile(path.join(project,'public/index.html'),'utf8'));
await fs.writeFile(path.join(out,'index.html'),html);
await writeLicenses(out, Object.keys(result.metafile.inputs));
await fs.writeFile(path.join(root,'build-inputs.json'),JSON.stringify({ inputs:Object.keys(result.metafile.inputs),outputs:Object.keys(result.metafile.outputs) },null,2)+'\n');
console.log(`Native web bundle built from ${Object.keys(result.metafile.inputs).length} public/shared inputs.`);
