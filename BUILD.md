# Build and verification

## Android

- Node.js >= 22.5; JDK 21.
- Android SDK Platform 36 / Build Tools 36; minimum Android API 24.
- Run `npm ci` inside `app`, then `npm run android`.
- Generated web assets, Gradle caches, APKs, SDK paths and signing files are ignored by Git.

This source targets Android **0.6.3 preview**, versionCode **20**, application ID
`app.naipocket.local`. It remains a preview: real-device behavior and paid
generation have not been verified. Use the same release signing identity when
updating a 0.1.0 installation; keep the original 0.1.0 APK/source pair intact.

`npm run android:release` reads these optional environment variables:

| Variable | Value |
| --- | --- |
| `NAI_ANDROID_KEYSTORE_PATH` | Absolute path to a private release keystore |
| `NAI_ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `NAI_ANDROID_KEY_ALIAS` | Signing key alias |
| `NAI_ANDROID_KEY_PASSWORD` | Signing key password |

Provide all four together. Preserve the key outside the repository: future updates to the same installation require the same signing identity. Do not publish keystores, passwords, local SDK configuration or application data.

## Source layout

```text
public/             shared editor UI, parameters, PNG, Tag and codex protocols
service/            accounts, generation, queue, gallery, translation and other services
service/storage/    transaction programs shared by sync and async SQLite
app/src/            native API, files, images, credentials and HTTP adapters
app/android/        Android Keystore, native HTTP, notifications, file export and updates
```

Services run over injected storage, file, image, HTTP, clock and ID ports; the queue and
request protocol do not depend on Android or Node. Host adapters own platform operations.

Custom HTTP relay addresses require the relay's explicit `allowInsecureHttp` setting.
The shared service forwards that consent through the JavaScript adapter to the native
HTTP bridge; HTTPS remains the default. Android's network security configuration allows
cleartext because relay hosts are selected at runtime, while the bridge rejects HTTP
without the flag and refuses automatic redirects. The WebView still uses an HTTPS local
origin with mixed content disabled; updater and resource downloads still require HTTPS.
HTTP does not encrypt Keys or generation data. Device network reachability must be
checked on the intended Android version and network.

## Checks

```sh
npm test
cd app
npm run test:http
npm run test:focused-inpaint
npm run test:relay-settings
npm run build
npm audit
```

## Offline integration

Set `PLAYWRIGHT_MODULE` to an installed Playwright `index.mjs`, and optionally `CHROME_PATH` to the browser executable. From `app`, run `npm run build`, then `npm run test:offline`.

The check creates temporary SQLite and files and uses synthetic PNGs and Tokens. It validates UI Token entry and commit rollback, official/RBQ routing, vault reload after page reload, explicit Vibe encoding accounts/consent/cache, queued-account protection, uploads, gallery, Canvas clean export and token-free backups. Artist checks cover browsing, search, local favorites/notes across reload, Prompt insertion, on-demand NAX image rendering and backup restoration through the file-import UI. The native bridge and upstream HTTP are simulated; no live image-generation request is made.

## Interactive browser review

For a short Chinese walkthrough, see [体验与手机调试](app/docs/REVIEW.public.md).

From `app`, run `npm run preview:offline`, then open the loopback URL printed in the terminal. This requires Node and the app dependencies, but no Android SDK, Playwright or real Token. Stop it with Ctrl+C.

The review page embeds the current Android UI at selectable widths and seeds two demo accounts, a scheme and placeholder gallery images. Use the ordinary settings/editor/queue/gallery controls. Only the displayed demo credentials are accepted. Requests stay local; generation is simulated and external resources are disabled. Database/files are isolated in a fresh temporary directory for each run; the synthetic vault is in memory. System file export explicitly reports that it requires a device, rather than pretending to save a file.

To review a selected real collection locally, run from `app`:

```sh
npm run preview:offline -- --artist-source /path/to/prepared.json --artist-images /path/to/selected-images
```

These paired flags are accepted only in interactive preview mode. The producer's
same preparation checks validate the explicit source and selected files, then the
shared installer loads them into a fresh disposable SQLite/files directory before
the UI starts. No existing preview is changed. The wrapper distinguishes selected
artist resources from simulated generation/gallery data and reports actual image
and annotation counts. This exercises reading/rendering, not Android ZIP-picker
or network transport. Inputs stay outside the APK and public source export.

This preview does not package an APK or establish Android Keystore, keyboard, file-picker, notification, process-restart or background behavior. Its network isolation also prevents live public artist/codex image retrieval. In the default preview, search for `anmi` to review three synthetic local examples with AI-initial, manually confirmed and missing annotation states; they are not that artist's work. Typed filters require all dimensions to match one observation. The native reader stores prepared resources separately from personal preferences and preserves image IDs, annotations and provenance. Local ZIP import and public GitHub Release ZIP download use native streaming and an atomic shared installer. The synthetic UI fixture checks successful import/rendering, checksum failure/disposal, download progress, cancellation, delayed cancellation acknowledgments and retained preferences. The interactive browser preview cannot operate Android’s picker or perform real downloads. Real resources are separate downloads; download resumption is not implemented. Cold-start cleanup protects committed mappings and reclaims recognized interrupted/old resource directories before readers mount; WebView or Activity recreation cannot repeat it in the same process. The offline check invokes the registered Back callback to verify dialog/detail/list/editor ordering, draft retention and example URL cleanup, but cannot establish OS gesture or keyboard behavior.

Run `npm run test:artist-resources` from `app` with JDK 21 to check archive and download handling with local JVM fixtures. These checks use fake HTTP connections and do not establish Android network reachability. Resource downloads currently require keeping the app in the foreground and restart from zero on retry; see [the pack contract](app/docs/ARTIST-PACK.public.md) for space admission and size bounds.

## Device acceptance still required

On a real Android device: import a PNG, store a test account, generate once with the account owner's approval, background/restore the app, cancel a queued task, export an image, and restart the app. Confirm no duplicate request and that unfinished running work is not silently resubmitted. Test the OS notification and file picker on the intended Android versions. For resource packs, interrupt extraction, restart the process, and check that the old installed version remains usable; after a completed update, restart again and check that the new version is retained and old bytes are reclaimed. Repeat with Activity recreation and an active image view to verify that cleanup does not run twice in one process.

The foreground service improves process priority and uses a bounded wake lock. It stays active through rate-limit cooldowns and stops when the queue becomes paused or empty. Run `npm run test:queue` from `app` for the focused worker/scheduler and pause/cancel wiring checks. These simulated checks do not replace device acceptance: Android or a device vendor can still terminate the process. Do not describe it as an always-running server.

## Resource package preparation

The checked-in `app/src/artist-roster.json` contains 12,866 selected offline names
and their aliases, independently of installed examples. Ordinary APK builds use this
file directly. To regenerate it from a prepared collection, run
`node scripts/build-artist-roster.mjs prepared.json app/src/artist-roster.json --replace`
from the source root. The producer selects identity fields only, reads no image
files, and rejects overwriting unless `--replace` is explicit. Run
`node tests/artist-roster-producer.test.mjs` for its focused checks.

From the source root, `node scripts/build-artist-packs.mjs prepared.json selected-images new-output-directory`
builds deterministic resource ZIPs and a size/checksum/coverage catalog. See
[the pack contract](app/docs/ARTIST-PACK.public.md) for the prepared input and stable
64-shard ownership rule. Run `node tests/artist-pack-producer.test.mjs` for focused
producer/installer checks. This tool has no server/database or upload access;
review actual data separately before publication. The app can load a catalog URL
that the user enters, find packs by artist name and install selected versions.
No default catalog is configured and the project distributes no artist-example
packs: example originals are third-party works with copyright and content-rating
concerns. Only the lightweight name/alias roster is bundled in the APK/source.

## Dependency notices

JavaScript runtime licenses are collected automatically during the web build. After changing native dependencies, run a release build, then `pwsh -File app/scripts/collect-native-notices.ps1` from the repository root to refresh the resolved Maven component list and packaged notices. Review license changes and rebuild the APK so its license view includes them. The Ionic Filesystem and SQLCipher notices are preserved separately under `app/licenses`.

## Current limits

- PNG text metadata and the shared RGBA decoder are supported. Unusual PNG encodings that require a platform decoder may not expose hidden metadata.
- The public app omits server administration, private collection/annotation workers, sample rotation and the Storm queue UI. The artist-resource reader, local ZIP installation and download from a user-entered catalog are implemented. No example packs are distributed; old resource versions are reclaimed on the next cold process start. See [the pack contract](app/docs/ARTIST-PACK.public.md) for schema and limits.
- Public services may be unavailable, require cold-start time, or apply quota limits.
- Android backups contain schemes, snippets and local artist favorites/notes. Import merges artist names, replacing matching preferences with the backup values and retaining other local records. Old backups without artist preferences remain supported. Export original images separately; Tokens remain device-local. Public example images are not included in backups.
