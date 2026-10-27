# Changelog

## 0.7.1 — Preview

- Artist data follows the website's library. The annotation packs list 22,865 artists with 56,667 g/s originals (was 12,866 / 29,464); about 10,000 new artists come with Danbooru picture links but no per-image annotations yet. 画风数据 covers 21,137 artists and 55,742 originals (was 10,984 / 28,966). With the earlier data installed, the artist page offers 去更新; the old data stays until the new one is verified.
- 依据 (new in the app): the 画风 panel chooses what styles are compared on — 混合 (default), V5 出图 or 原作 — as on the website. 画风数据 now also carries the style vectors of the 12,779 V5 example pictures (about 63 MB in all, one download).
- 画风 panel redone in three sections: 依据; 感觉词, with how to use it beside the title; 标注筛选, a list of 精确 / 只看有标注 / 只看已确认 switches followed by 画风特征 / 细化特征 / 构图与作品类型, which open in place. One footer: 清空 (only what this panel chose) and 收起.
- 读取图片参数: the dialog opens as soon as a picture is chosen, showing it and 读取中 · N 秒; a picture without parameters is explained there, with 换一张图; closing it cancels. JPEG photos are read from their header only.
- 以图找画师: a 像这张图 · 分析中 pill with the picture appears at once; tap it to cancel.
- 语义工作台: the example searches are gone.

## 0.7.0 — Preview

- 反推 has its own tab beside 编辑, one tap from every page. In the app it is the free WD Tagger: pick a picture (or one from the gallery), tap away the Tags you do not want, add the rest to the editor.
- 语义工作台 redone. 查词: describe what you want in the card and tap 搜索 inside it; the search modes and NSFW sit on one row; a few example searches to tap before the first search. 联想: starts from the Tags you ticked in 查词 (or the current section, or all), shows them as chips you can drop, and 相关 Tag / 相近画师 runs at once. One selection across both pages; the bar under it reads 已选 N · 清空 · 联想 → · 加入<section>.
- 问秋月 (new, in 语义工作台): SAkizuki's 问秋月 inside the app — 写提示词 to have its agent turn an idea into a prompt, 问写法 to ask about writing prompts. Paste what it wrote into the box under it and tap 加入 to add it to the section as Tags (one undo step). It runs on the author's service; you can set your own API key in its ⚙.
- 法典: a rail on the right of a long section jumps anywhere in it — drag to 第 N 条 and let go; 载入前面 fills in the page before without moving the screen. The rail shows where you are while you scroll.
- 画师预览: no explanatory captions; the line under the name says only whether the artist: prefix is there.
- 回收站 on phones: three per row across the full width, the remaining time on the picture, small 恢复 / 删除 buttons.

## 0.6.5 — Preview

- V5 例图 (new, optional download, about 540 MB): one NovelAI V5 Full picture for each of 12,703 artists, all from one base prompt with only the artist tag changed, so styles compare side by side. Settings → V5 例图 reads the catalog and shows the size, then downloads; 删除 removes only these pictures. They appear in the artist page's 生成 group (and as the cover for an artist without an original), and 查看生成依据 shows each picture's Prompt, UC and parameters (16 or 28 steps). Independent of the annotation packs: updating either never touches the other.
- Artist name check: an artist: tag whose name is in neither the artist library, the NAX index nor the aliases gets an orange 「?」. Opening it suggests the closest real names (hitten → hiten (hitenkei)) with a one-tap 改成, and checks Danbooru: the artist exists (with post count), is another name of an artist, is an ordinary tag rather than an artist, is banned, or does not exist. Checked artists are remembered; 确认是画师 marks one by hand. Prompts from elsewhere often carry misspelled names, which NovelAI silently ignores.
- Fixed: the 画风相近 covers in 画风概览 were blank.

## 0.6.4 — Preview

- Quality Tags and UC presets now really apply: NovelAI's servers expand neither switch, its own client writes the text, and the app now does the same (quality tags at the end of the prompt, before any Text: block; the preset text in front of your UC; on Full models nsfw in the UC unless the prompt asks for it). Before, only the switches were sent and had no effect, so new pictures look closer to the official site.
- UC preset is a named dropdown: Heavy, Light, Furry Focus, Human Focus, None (NovelAI's order).
- V5 Full · Medium in the model list: NovelAI's cheaper Medium effort (a distilled checkpoint, 14 steps, Euler Ancestral, Heavy UC only, about 42% less). The bar shows the pinned values; your own UC and character UCs are not sent.
- fur dataset is an ordinary tag that is moved to the front of the prompt on V4 and later, as NovelAI requires.
- Restoring parameters gives back what really took effect: the automatic text comes out of the editor and its switch turns on; pictures that only recorded the switches (Pocket before this version) restore with them off, so a regeneration matches. Newer official images that carry only tag hints restore the right preset.

## 0.6.3 — Preview

- Third-party relays: a saved relay can explicitly allow HTTP; HTTPS remains the default. Optional site/internal Key fields are concatenated without separators. Saving settings does not send a generation request.
- Relay responses: bounded gzip decoding, readable upstream errors, and no automatic second generation when a successful response cannot be decoded or downloaded.
- Focused inpaint: select context, paint the desired edit, generate an enlarged crop and composite it back at the original size. Pixels outside the original mask are preserved; regions survive schemes and drafts.

## 0.6.2 — Preview

- Fixed (#1): on phones that draw apps edge to edge (seen on a Redmi K80 with 全屏显示), the header, the settings close button and the bottom tabs sat under the status bar and gesture bar and could not be tapped. The app is now padded out of the system bars natively, and the bar areas use the app background with light icons.
- 队列: finished jobs are a picture grid under 已完成 (four per row on a phone); tap a picture to view it, 日志 stays under each one. Waiting, running and failed jobs keep their rows.

## 0.6.1 — Preview

- 画风空间: 找相似, 以图找画师 and 画风相近 now compare artists in a learned style space that discounts subject matter and character design (hair and eye colour, outfits, vehicles, scenery), so a picture of one character no longer pulls in artists who merely drew the same character. Needs the new 画风数据 (Settings → 画风数据 → 检查更新); feel words are unchanged.
- 回收站 (new): deleting from the image viewer needs no confirmation; the picture stays in 回收站 (a fourth gallery view beside the other three) for 24 hours and can be restored, then is deleted for good.
- 读取图片参数: grouped by what restoring really does, with NovelAI's own names; WebP and JPEG are read as well as PNG (the hidden alpha record in WebP, EXIF / XMP / comments), and a picture without any record says why.
- Editor text mode: the tools under the text are two thin rows (拆成卡片, 顺序 switch); the order of the four groups can be changed; ↺ 按卡片重写文本 appears only after the text was edited by hand.
- Messages: duplicates and stacked banners when adding artist tags are fixed.

## 0.6.0 — Preview

- 以图找画师 (new): the picture button in the artist page search bar ranks artists by how close their style is to a picture you choose, on the phone and offline, and combines with feel words. It needs 画风数据 and an optional one-time model download (about 293 MB, Settings → 以图找画师), verified by checksum; pictures never leave the phone.
- 画风概览 redone: 画风指纹 shows the feel words an artist stands out on as bars (tap one to find artists strong in it) and the ones clearly absent; 画风相近 lists the six closest artists with their most similar picture; the annotation evidence is folded under 标注明细.
- Messages: one message per action, in one place (inside an open sheet, otherwise at the top); at most three at once, a repeated message refreshes instead of stacking; adding an artist no longer shows two messages.
- Artist list: the count and the pager keep one line; how the list was read and 有新结果 · 更新 sit on their own line.
- The APK now contains code for ARM phones only (arm64-v8a, armeabi-v7a); ONNX Runtime brings it to about 40 MB.

## 0.5.0 — Preview

- 画风数据 (new, optional download, about 24 MB): the artist page can now rank artists by feel and find similar artists. Settings → 画师标注资料 → 画风数据 downloads it from its own GitHub Release, verifies it and switches over only after it decodes; the artist page offers it once the annotation packs are installed. It holds style vectors and artist names for the g/s originals of the annotation packs, no images, and works offline.
- 画风 panel: feel words (ranked by image style) and annotation words (corner mark, exact per-image filter) share one panel in groups 氛围 / 场景 / 画法 / 色彩 / 质感 / 造型 / 年代 / 题材 / 画面, 51 feel words, each with its own lit look; 精确 also requires a matching annotation. Typing a word such as 「水彩 梦幻」 in search lights it. The older style grids stay under 更多标注筛选.
- Cards show which chosen words an artist stands out on, and unannotated artists get two automatic feel words (✦). Tapping a word no longer pulls the page back to the panel.
- Artist page header: rounded search with a ✦ 画风 button, one scrolling row for model, sort, favourites and chosen words, and number-first stats.
- Artist detail: one icon bar (生成例图 when available, 找相似, 笔记, 添加例图 when available), the artist's standout feel words under the name with 「画风 ›」 for the style overview, and the note's first line.
- Editor: 快删 keeps a fixed width (trash icon; solid red ✓ 完成 when on); the top-bar 导入 button is gone, 导入 NAI / JSON stays in the ⋯ menu.

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
