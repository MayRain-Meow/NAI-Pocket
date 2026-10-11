# NAI Pocket

**把 NovelAI 工作台装进口袋。** 一款为手机设计的 NovelAI 客户端：双语 Tag 积木编辑、自动分栏、多角色与参考图工作流、后台队列和本机图库。Android 本地运行，用你自己的 Token，不需要服务器。

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-d6a774)](LICENSE) ![Android](https://img.shields.io/badge/Android-7.0%2B-7fbf95) ![Status](https://img.shields.io/badge/status-0.3%20preview-ab9cf0)

<p align="center"><img src="docs/screenshots/demo-sort.gif" width="300" alt="粘贴一段 Prompt，自动分进场景、镜头、画风、其他四栏"></p>

<p align="center">▶ <a href="docs/promo/nai-pocket-promo.mp4">观看 46 秒宣传片（MP4）</a></p>

<p align="center">
<img src="docs/screenshots/editor.png" width="200" alt="四栏 Tag 编辑">
<img src="docs/screenshots/helpers.png" width="200" alt="⋯ 菜单里的辅助功能">
<img src="docs/screenshots/codex.png" width="200" alt="法典：看图挑配方">
<img src="docs/screenshots/artists.png" width="200" alt="画师资料库与逐图标注">
</p>

> 截图与宣传片来自离线预览：法典画面是 QuickTagCloud 公开法典的内容，其余生成结果与例图为合成占位图，不是真实生成作品，也不是真机实拍。

## 亮点

- **Tag 积木**：每个 Tag 是一块带中文释义的卡片，可调权重、停用、编辑、拖动排序，随时切回纯文本。
- **自动分栏**：粘贴整段 Prompt，按场景、镜头、画风、其他自动归类；画师 Tag 优先识别。
- **完整工作流**：多角色分区提示词、文生图、Img2Img、Inpaint、Precise Reference、Vibe Transfer 和官方图片工具。
- **后台队列**：本机 SQLite 持久化；支持暂停、取消、手动重试、账号切换和 429 冷却。
- **图库与方案**：原图、缩略图、预览分开保存；支持搜索、收藏、备注，一键恢复参数；方案和片段可导入导出。
- **从图片还原**：读取 PNG 里的 NovelAI 参数，包括隐写元数据；可生成去元数据副本。
- **画师资料库**：与网站版同一套画师界面，12,866 位画师的名字和别名，按画风维度筛选，逐图标注、收藏、备注，一键加入画风。
- **查找灵感**：QuickTagCloud 法典、WD Tagger 反推、公共 Danbooru Tag 搜索。

## 当前状态

**0.3.5 preview 预览版**，还不是正式稳定版。本地合成数据的集成检查已通过；以下项目**尚未验证**：
- 真实设备上的生成、下载、后台持续运行和系统文件选择；
- 真实付费生成。

早先的 0.1.0 APK 不含这些后续修改。

## 使用须知

生成需要网络及有效的上游账号。离线可编辑、管理已保存的方案和图库。反推会把所选图片上传到公共 WD Tagger 服务；公共搜索和翻译会发送相应文本。客户端不提供生成额度。

应用启动时最多每 12 小时向 GitHub 查询一次新版本（「设置 → 应用更新」可手动检查）；安装包校验签名后交给系统安装程序，首次需允许「安装未知应用」。

## 安装与使用

1. 安装与本版本源码配套的 APK，或按照下文自行构建。
2. 打开右上角设置，选择官方或 RBQ，添加该渠道自己的 Token。NovelAI 官方使用 `pst-…` Persistent API Token；RBQ 使用自己的 RBQ 凭据。
3. 编辑 Prompt 和参数，确认账号、尺寸与批量数量后生成。
4. 图库下载通过 Android 系统文件选择器保存；方案页可导出方案、片段和画师收藏/备注备份，不包含 Token、原图或在线例图。
5. 生成完成的原图默认另存一份到手机相册 `Pictures/NAI Pocket`（Android 7–9 首次会请求存储权限），可在设置「手机相册 → 保存到手机相册」关闭；复制失败不影响任务和应用内图库。

Token 由 Android Keystore 加密后保存在应用私有目录，数据库与图片也在本机。卸载会移除这些数据（已复制到手机相册的图片除外，相册对有相册权限的其他应用可见）；请提前导出所需图片和备份。导入备份时，同名画师的收藏和备注以备份为准，未包含的本机记录保留；旧版备份也可导入。收到图片后发生本地保存错误，不会自动再次请求生成。应用进程中断的运行中任务会标为失败，由用户决定是否重试。

画师**标注资料包**只含画师名、逐图画风标注和 Danbooru 图片地址（仅 g/s 分级），**不含任何图片**；打开画师时，例图从 Danbooru 按需读取并缓存在本机。项目不分发第三方原图。资料包在「设置 → 画师标注资料」中读取目录安装，也可导入自己准备的资料包，格式见[资料包说明](app/docs/ARTIST-PACK.public.md)。标注资料包随[独立 Release](https://github.com/MayRain-Meow/NAI-Pocket/releases/tag/artist-annotations-2026-10-10) 发布（64 个分包，共约 79 MB），应用默认读取它的目录。

RBQ 的未缓存 Vibe 参考编码需要另外选择官方账号并确认消耗；官方图片工具需要官方账号。不熟悉调试时，按 [体验与手机调试说明](app/docs/REVIEW.public.md) 先看电脑预览，再检查手机行为。

本项目与 NovelAI 无隶属关系。第三方服务及数据的署名见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 构建

需要 Node.js 22.5 或更新版本、JDK 21、Android SDK Platform 36 和 Build Tools 36。配置 `JAVA_HOME` 与 `ANDROID_HOME`，并接受 SDK 许可证。

```sh
cd app
npm ci
npm run android
```

debug APK 位于 `app/android/app/build/outputs/apk/debug/app-debug.apk`。首轮构建会下载 Gradle 与 Android 依赖。

发布构建使用 `npm run android:release`。若未配置签名环境变量，会产出 unsigned APK。配置说明见 [BUILD.md](BUILD.md)；签名密钥不得提交到仓库。

## 结构

```text
public/             共用编辑器 UI、参数、PNG、Tag 与法典协议
service/            账号、生成、队列、图库、翻译及其他业务服务
service/storage/    同步与异步 SQLite 共用的事务程序
app/src/            本机 API、文件、图像、凭据和 HTTP 适配
app/android/        Android Keystore、HTTPS、通知与文件导出
```

业务层通过注入的存储、文件、图像、HTTP、时钟与 ID 接口运行。队列和请求协议不依赖 Android 或 Node；宿主适配器负责平台操作。

## 检查

```sh
npm test
cd app
npm run build
npm audit
```

离线集成检查还需要 Chrome 和 Playwright：设置 `PLAYWRIGHT_MODULE` 指向其 `index.mjs`，运行 `npm run test:offline`。它使用真实浏览器和临时 SQLite/文件，模拟原生桥与上游响应，不消耗生成额度。它不能代替 Android Keystore、系统生命周期和真实网络的设备验收。

## 许可

项目代码采用 [AGPL-3.0-only](LICENSE)。第三方代码与数据保留各自许可；法典在运行时访问；本项目不分发画师图片，第三方作品的权利不因代码采用 AGPL 而改变。
