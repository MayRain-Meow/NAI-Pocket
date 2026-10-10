# Third-party notices

NAI Pocket is an independent client. Third-party names identify compatible services and sources, without implying endorsement.

| Component or service | Use / attribution |
| --- | --- |
| [NovelAI](https://novelai.net/) | User-supplied account for image generation; no account or credits are bundled |
| [NAX V5 artist gallery](https://nax.moe/?gallery=danbooru-artist-tags-2-v5) | Artist-name snapshot in `public/artist-index-v5.js`; no gallery images are bundled |
| [QuickTagCloud](https://novelai.quicktagcloud.com/) | Read-only community codexes fetched at runtime; original links and attribution remain in results |
| [WD Tagger](https://huggingface.co/spaces/SmilingWolf/wd-tagger) | Optional online image-to-tag service, model `wd-eva02-large-tagger-v3`; the selected image is uploaded when requested |
| [DanbooruSearch](https://sakizuki-danboorusearch.hf.space/) | Optional public semantic Tag search; results retain the endpoint and source information |
| [MyMemory](https://mymemory.translated.net/) | Optional remote text translation |
| [NovelAI image metadata](https://github.com/NovelAI/novelai-image-metadata) | Compatible stealth metadata implementation; MIT notice in `app/licenses/NovelAI-metadata.txt` |
| [Pako](https://github.com/nodeca/pako) 3.0.2 | Vendored bounded PNG/ZIP decompression; MIT / Zlib notices in `public/vendor/pako-LICENSE.txt` |
| Capacitor 8, Capacitor App / Filesystem, community SQLite | Platform bridge; their original licenses are included in the APK license view |
| Buffer, base64-js, ieee754, Capacitor Synapse | Browser runtime dependencies; their original licenses are included in the APK license view |
| [Ionic Android Filesystem](https://github.com/ionic-team/ion-android-filesystem/tree/1.1.1) 1.1.1 | Native file operations; MIT notice in `app/licenses/Ionic-filesystem.txt` |
| AndroidX / Android support libraries, Kotlin / coroutines, OpenSSL 3 | Native dependencies distributed under Apache-2.0; license in `app/licenses/Apache-2.0.txt` |
| [SQLCipher](https://github.com/sqlcipher/sqlcipher), [SQLCipher Android](https://github.com/sqlcipher/sqlcipher-android) 4.17.0 | SQLite platform library; original BSD notices in `app/licenses/SQLCipher.txt` and `app/licenses/SQLCipher-Android.txt` |

Licenses and attributions are available from the app's Settings → About / Licenses view. `app/scripts/licenses.mjs` collects the exact installed runtime package notices during each build. `app/licenses/Native-dependencies.txt` lists the resolved native release components and their packaged notices; refresh it when native dependencies change. Third-party source data and images keep their original terms; this repository does not grant rights to redistribute them.
