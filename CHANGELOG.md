# Changelog

## 0.4.0 — Preview

- 部分恢复 redesigned: a 替换 / 追加 switch (追加 adds only the Tags, characters and UC entries you do not have yet and never removes anything), a full-restore card, and tiles grouped by section and tinted with the editor's section colours, each showing its count.
- Scheme details use the same restore design, including Global UC and single characters.
- 用此图创作 tiles keep their text inside on every phone; descriptions wrap to two lines.
- Gallery text search reads a small search table, so searching a large gallery is much faster.
- Artist search keystrokes are lighter.
- The app stays in portrait.

## 0.3.9 — Preview

- 用此图创作 redesigned as grouped icon tiles (继续创作 / 作为参考 / 官方工具) with Chinese names and one-line notes.
- 部分恢复 uses the pressable buttons; the editor top bar (side switch, 文本, icon buttons, 快删) is restyled, and 文本 now shows its on state right away.
- Settings → 关于: version, author MayRain-Meow and the GitHub address, with the licence view.

## 0.3.8 — Preview

- Text mode redesigned: weighted spans are tinted (warm for raised, cool for lowered weight, deeper for stronger), a soft text box, one compact 复制, and the 拆分 / 覆盖 / 顺序 actions grouped.
- Tag suggestions float under the input instead of pushing the page down, and open above it when the generate bar leaves no room.
- Confirmations appear in the middle of the screen; the image viewer's 恢复 lines up with the other buttons; Anlas is shown as one total.

## 0.3.7 — Preview

- Third-party relays: RBQ is now one entry under 管理第三方中转 (listed once it has a Key), and any NovelAI-compatible relay can be added with an https address and a Key. Relays get plain generation; Vibe references are encoded with an official account first, as with RBQ before.
- Relay responses are recognised by their content (raw image, ZIP, NovelAI or OpenAI-style JSON, an https image link, event streams), and an upstream error message is shown as-is instead of a generic failure.
- Option lists and confirmations use the app's own sheets instead of system dialogs; 自定义始末 in the gallery starts on the last 30 days.
- Buttons in the image viewer, schemes and the artist example menu get a pressable look; the example menu no longer opens off-screen.

## 0.3.6 — Preview

- Artist detail back to a compact layout: cover beside the name, style tags and 加入画风, with every action in one grid right below; 资料 and 画风概览 open as sheets; tapping an example opens the full viewer.
- README rewritten as a product introduction; build, source layout and checks moved to BUILD.md.

## 0.3.5 — Preview

- Artist detail redesigned: big swipeable pictures first, then name, style tags and 加入画风, the examples grid, style overview and profile on one page.
- Danbooru artist facts (post count, dates, profile links) sync in the app: per artist or for the whole library, paced.
- In-app updates: the app checks GitHub releases (at most every 12 hours or on demand), downloads and verifies the APK, then opens the system installer.

## 0.3.4 — Preview

- Less empty space between the top bar and page content on phones (gallery, schemes, queue, editor); the artist page no longer repeats the page title.
- README: new demo, screenshots and a 46-second promo video.

## 0.3.3 — Preview

- Fixed: opening the artist page after installing the annotation packs could crash the app; annotations are now read in bounded pages and descriptions only for text searches.
- Editor: the round ＋ is the one add action; 整块 appears only when the input holds several items; 语义 is a ✦ icon. The 语义 workbench has two tabs, 查词 and 联想, with less explanatory text.

## 0.3.2 — Preview

- Startup shows a launch screen instead of briefly flashing the login page.
- The artist page tells you when no annotation packs are installed (with a shortcut to download them) and when example images repeatedly fail to load from Danbooru.

## 0.3.1 — Preview

- The image-free artist annotation packs are published as their own Release and are the default catalog in Settings.

## 0.3.0 — Preview

- The artist page is now the same artist-library UI as the server site: cards, style filters, details with per-image annotations, favourites, notes and 加入画风; library management tools are not included.
- Artist annotation packs: names, per-image style annotations and Danbooru CDN image links (ratings g/s only), no image files; thumbnails load on demand and are cached on the device. Packs are installed from Settings.
- Generated images are also copied to the phone gallery (Pictures/NAI Pocket); a Settings switch, on by default.
- Editor: ＋ and 整块 form one split add button; the position sheet has an 自动 switch and a named coordinate readout with two decimals; the 语义 workbench is split into ① 查词 and ② 联想.
- Android back closes panels and returns from an artist's details to the list.

## 0.2.1 — Preview

- First run shows a step to add your own NovelAI Token or RBQ Key, with a shortcut to settings.
- No artist resource catalog is configured by default; the pack download entry is labelled as a link download.

## 0.2.0 — Preview

- Complete offline artist name/alias roster. Artist-example packs are not distributed; the pack reader, local import and download from a user-entered catalog remain.
- Official/RBQ accounts use device-local credentials; explicit official-account selection for uncached Vibe encoding.
- Queue foreground service remains active through rate-limit cooldowns; pause/cancel wake it promptly.
- Real-device generation, background behavior and resource installation acceptance remain pending.

## 0.1.0 — Preview

- Local Android client using shared editor, generation, queue, gallery and storage services.
- Device-local encrypted Tokens, image export and token-free scheme backups.
