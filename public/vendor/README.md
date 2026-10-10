# Vendored browser codecs

- `pako-inflate.js` is the unmodified inflate-only browser ES module from
  pako 3.0.2: `dist/browser/pako_inflate.esm.min.mjs`.
- Source package: <https://registry.npmjs.org/pako/-/pako-3.0.2.tgz>.
- Upstream: <https://github.com/nodeca/pako/tree/3.0.2>.
- License: MIT and Zlib. Both notices are in `pako-LICENSE.txt`.
- Only the local filename differs. The upstream source-map annotation is retained;
  its optional map is not bundled.
- `public/png-metadata.js` bounds decompressed output while streaming. Node
  adapters inject native zlib and retain their existing error contract.
