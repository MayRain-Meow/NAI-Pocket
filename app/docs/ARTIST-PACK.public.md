# Artist resource pack v1

The working native source can import a local ZIP through Android's document
picker or download a public GitHub Release ZIP using its asset URL.
The public source contains synthetic fixtures only; no actual artist collection
is attached. Device picker/lifecycle behavior still requires Android acceptance.

## Container and limits

Use a flat ZIP containing UTF-8 `manifest.json` and the image files it names.
An annotation-only pack (see below) names no image files, so its ZIP contains
only `manifest.json`.
Directories, extra files, duplicate names and path traversal are rejected. Each
image is at most 4 MiB, the manifest at most 8 MiB, and both compressed input and
total extracted output are limited to 256 MiB per ZIP. A shard may contain at most
2,000 artists, 8,000 examples and 16,000 images. Large collections require multiple
shards; each artist belongs to one pack ID. An update replaces that pack's content.

The manifest has these fields:

| Field | Value |
| --- | --- |
| `format` | `nai-pocket-artist-pack` |
| `formatVersion` | `1` |
| `id` | Stable shard ID, ASCII letters/digits/underscore/hyphen, at most 100 characters |
| `version`, `title` | Nonempty display strings, at most 100 and 200 characters |
| `synthetic` | `true` for fixtures; omitted or `false` for a real collection |
| `artists` | Array of records described below |

Each artist record contains `artist` (display name), `aliases` and `examples`.
Names are normalized for identity using the shared artist-index function.
Normalized duplicate identities are rejected. Zero to four retained originals
are accepted; this preserves incomplete coverage and the existing fourth-example
edge case without silently dropping content to meet the three-image target.

Each example has a globally unique `id`, `sourceType: "original"`, HTTP(S)
`sourceUrl`, positive integer `width`/`height`, `note`, `metadata`, `observations`,
and exactly one of `images` (files inside the ZIP) or `remoteImages` (pointers to a
public CDN, described below). One pack may mix both kinds. `metadata` preserves prepared source information; it must not be
populated by copying unrelated private database state. `images.thumb` and
`images.preview` each contain:

- `name`: exactly `<example-id>-<tier>.<ext>`, where tier is `thumb` or `preview`;
- `ext`: `png`, `jpg` or `webp`;
- `bytes`: positive byte length of that exact file;
- `sha256`: lowercase 64-character SHA-256 digest of that exact file.

`remoteImages.thumb` and `remoteImages.preview` are URLs on `https://cdn.donmai.us/`
only. The path must be `/<variant>/<xx>/<yy>/<md5>.<ext>`, where variant is
`180x180`, `360x360`, `720x720` or `sample` (sample files carry a `sample-` prefix),
`xx`/`yy` are lowercase hex pairs, the md5 is 32 lowercase hex characters and the
extension is `jpg`, `png` or `webp`. Query strings, fragments, ports and user info
are rejected. Remote examples add nothing to the pack's file list. `formatVersion`
stays `1`; apps that predate this field reject such a pack instead of installing it
without images.

Every observation carries its original `id` and matching `exampleId`, `model`,
`schemaVersion` (1 or 2), `facets`, `attributes`, `note`, `reviewed` (boolean),
`source` (`manual`, `assistant-visual` or `danbooru-tags`), `provenance`, and
`updatedAt` (integer timestamp or null). Typed attributes use
`public/artist-style-schema.js`. Preserve real IDs, provenance and review states;
do not convert automatic observations to manual confirmations. The fixture
producer in `tests/artist-pack-fixtures.mjs` is a minimal executable example.

## Installation contract

`ArtistPackArchive` streams extraction, digests and image inspection into a fresh
UUID directory below app-private `artist-resources/`. Archive/image bytes do not
cross the JS bridge as Base64. The shared installer validates the manifest and
compares every declared file's size, digest, MIME and bounded image dimensions
with the native extraction result. This proves internal consistency, not publisher
identity or permission to redistribute a collection.

One SQLite transaction replaces a shard's identities, examples and observations
and switches its directory mapping. Another pack cannot take ownership of an
existing artist. Failed validation or SQL writes keep the old metadata/directory
and discard the new staging directory. Personal favorites and notes are never
part of this replacement. Reads already bound to the old directory can finish.
Image URLs carry the metadata's directory revision: if installation finishes
before an older detail requests its image, that request asks the user to reopen
the profile instead of combining an old annotation with a new image.

Before extraction the app requires 288 MiB of free internal storage; downloading
requires 544 MiB to allow for the archive and extracted files together. These
conservative thresholds include a 32 MiB reserve. Old directories are retained
for the rest of the current process so existing image reads can finish. On the
next cold start, before mounting the UI, the app reads committed directory
mappings (including legacy sets) and removes unreferenced UUID pack directories
and its temporary download ZIPs. Cleanup accepts only flat image directories;
unknown files, nested folders and symlinks are left untouched. It never changes
metadata or personal preferences. If the keep set cannot be read or validated,
no sweep starts; an I/O failure leaves remaining work for another cold start.
Page reloads and Activity recreation do not trigger another sweep in the same
process. Import/download cannot begin while this cleanup runs. The app does not
claim that importing metadata alone downloaded missing image bytes.

## Preparing release files

From the source root, run:

```sh
node scripts/build-artist-packs.mjs prepared.json selected-images new-output-directory
```

The producer accepts a deliberately prepared JSON collection and a flat directory
of selected thumbnail/preview files. It does not read a server database, credentials
or environment settings and does not upload anything. The source object contains
`format: "nai-pocket-artist-collection"`, `formatVersion: 1`, a stable collection
`id`, `version`, `title`, optional `synthetic`, and `artists` in the schema above.
Image descriptors require `name` and `ext`; `bytes` and `sha256` are computed,
and any supplied transfer checksums must match. Unknown record fields and obvious
credential fields/values or local paths fail preparation. This is not an automated
review of arbitrary free text or image redistribution rights; inspect the selected
content before publishing. Preserve public provenance while leaving operational
request IDs, account data and personal preferences out of the prepared source.

Each normalized artist name maps permanently to one of 64 shards using the first
SHA-256 byte AND 63. The pack ID is `<collection-id>-<two-digit-hex-shard>`.
Adding artists therefore does not move existing artists to different pack IDs.
Do not change the collection ID or partition rule for an existing installation;
cross-pack ownership transfer is not supported. A shard exceeding native limits
fails the build instead of silently moving artists. Zero-to-four retained examples
and all supplied observations keep their order, IDs and review states; the producer
does not create missing examples or turn AI observations into manual confirmation.

Images remain byte-identical inside deterministic stored ZIP files. Every shard
is validated with the same manifest contract used by the installer. The output
must be a new directory. `catalog.json` appears only after all shards are written
and records relative ZIP filenames, sizes, whole-archive hashes, artist names and coverage
counts, including missing examples/annotations. Failed builds retain an incomplete
output for diagnosis and never overwrite an earlier delivery. Catalogs are limited
to 2 MiB, with up to 64 shards. Keep a published collection/version immutable;
publish changed data with a new version. Publish only reviewed complete output
as Release assets, keeping the catalog and its ZIP files in the same release.

## Annotation-only packs

The published collection does not redistribute third-party artwork. It carries
artist names and aliases, the per-image style annotations, the source metadata
(Danbooru post id, rating, md5 and the recorded rendition) and `remoteImages`
pointers instead of image files. Only examples rated `g` (general) or `s`
(sensitive) are included. Examples rated `q` or `e`, together with their
annotation text and metadata, are excluded entirely. An artist whose examples were
all excluded remains listed by name with zero examples.

From the source root, run:

```sh
node --max-old-space-size=4096 scripts/build-artist-annotation-packs.mjs prepared.json new-output-directory [version]
```

The input is the same prepared collection that the full producer accepts. The
image directory is not needed. The thumbnail is the post's `360x360` JPEG, and the
preview is the rendition recorded in `metadata.variant`, usually `720x720` WebP. Examples
without a valid Danbooru md5 and rendition are dropped and counted. The output
uses the same collection ID, pack IDs, partition rule, catalog format, private-data
scan and catalog-last write as the full producer. A private full pack for a shard
therefore replaces the annotation pack for that shard, and the reverse also holds.
The default version string is `2026-10-10-annotations-gs-1`. The default title is
「画师逐图标注（不含图片）」.

The owner's private full ZIPs (images inside the ZIP) still import unchanged.

**Fetching and caching on the device.** An annotation-only example is stored with
image extension `remote`. Its validated URLs are kept in the example's metadata, so
no schema change was needed. When a thumbnail or preview is first shown, the app
fetches it through native HTTPS from `cdn.donmai.us`:
- `GET` only, with no redirects, cookies, tokens or credentials;
- `User-Agent: NAI-Pocket/0.3 (artist annotation preview)`, where the WebView allows that header;
- a 20-second timeout and at most four concurrent fetches; cancelled requests leave the queue.

The response must be an image of the URL's type, at most 4 MiB, with at most 10,000
pixels per side and at most 32 MP. It is then written to the app-private
`artist-cache/<example-id>-<tier>.<ext>`, and later views read that file. An invalid
cache file is ignored and fetched again. Failures are reported as follows, and
nothing is cached:
- network failures and timeouts: 「无法从 Danbooru 读取这张例图，请检查网络。」 (HTTP 502);
- a missing post: HTTP 404;
- invalid bytes: HTTP 502.

The directory-revision check still applies. The cache is not cleaned up or bounded
yet: viewing every example of a full collection can use several GB. Clearing app
data removes it.

Not yet verified: Danbooru rate limits under heavy scrolling, whether the WebView
keeps the custom User-Agent, and reachability of `cdn.donmai.us` from mainland
China on a phone.

## GitHub download

Paste the Release download URL of `catalog.json`, then choose **读取资料目录**.
The app shows pack sizes, original/annotation coverage and installed versions.
Search by artist name to find a containing pack, then download that pack. The
catalog includes `artistNames` per shard and the same coverage fields at collection
and shard levels; inconsistent counts or duplicate identities are rejected.
The successful catalog URL is remembered on this device; its contents are fetched
only on request. A default repository/download source is not configured yet.

The catalog is read through the same credential-free bounded-redirect transport,
with a separate 2 MiB response limit enforced even without Content-Length. ZIP
filenames are flat and resolved relative to that catalog's Release URL. Catalog
downloads require the listed whole-archive SHA-256; the installer also checks
the listed pack ID/version before any metadata write. A failed/cancelled directory
read preserves the previously displayed catalog and installed data.

Alternatively, expand **已有单个 ZIP 下载链接** and paste a public asset URL such as
`https://github.com/OWNER/REPO/releases/download/TAG/artist-pack.zip`, or its
`releases/latest/download/artist-pack.zip` equivalent. Downloads require no generation
Token or GitHub credentials. The native transport uses HTTPS and follows at most
three redirects, limited to `github.com` and `release-assets.githubusercontent.com`.
It streams to a temporary file with a 256 MiB bound, checks the received length,
and then uses the same archive validation and atomic installer as local imports.
Direct ZIP links still check every image against the downloaded manifest; unlike
catalog-selected downloads, they have no independent whole-archive digest.

Keep the app in the foreground. The UI shows downloaded bytes and verification
progress, and permits cancellation before the metadata transaction begins.
Cancellation is bound to its operation ID so a delayed request cannot cancel a
later download. The final database transaction cannot be interrupted halfway.
Failures retain the old installed version; retry starts a fresh download.
Cold-start recovery preserves committed packs and discards interrupted staging;
downloads do not resume automatically. No real corpus has been published or
exercised through this transport on an Android device.

## Focused checks

`node tests/artist-resources.test.mjs` covers the prepared reader and bounded
evidence filtering: 256-row batches, review/source eligibility, same-observation
matching, serialized consistency across pages and cancellation of stale scans.

Run `node tests/artist-pack-catalog.test.mjs` for directory admission, coverage
consistency and pre-transaction pack identity binding. Run
`node tests/artist-pack.test.mjs` for manifest, digest, cross-pack ownership
and synchronous/asynchronous late-transaction rollback checks. The offline UI
fixture covers the import action, successful local rendering, checksum failure,
staging disposal, cancellation and preference preservation through mocked native
ports, including download progress, cancellation and a delayed cancellation
acknowledgment arriving during a later install. It also verifies catalog loading,
artist-name search, version mismatch disposal, installed-state refresh and 360/820px
layouts. From `app`, run
`npm run test:artist-resources` with JDK 21 for the pure JVM archive, download and
maintenance tests. They cover redirects, credential-free requests, hashes, length
limits and cancellation using fake connections, plus real temporary-file cleanup,
active/legacy protection, invalid keep sets, symlinks and repeated recovery.
Android compilation checks plugin linkage without packaging an APK. Device
process-restart and Activity lifecycle acceptance remain outstanding.
