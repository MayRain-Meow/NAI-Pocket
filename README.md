# NAI Pocket

**手机上的 NovelAI 工作台。** 写 Prompt、挑画风、排队生成、管理作品，一只手就够。

用你自己的 NovelAI Token，或你选择的第三方中转，在手机本地运行，不需要服务器。

[![下载 APK](https://img.shields.io/badge/下载-Android%20APK-d6a774)](https://github.com/MayRain-Meow/NAI-Pocket/releases/tag/v0.3.8-preview) ![Android](https://img.shields.io/badge/Android-7.0%2B-7fbf95) ![Status](https://img.shields.io/badge/status-0.3%20preview-ab9cf0) [![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-8a8a8a)](LICENSE)

<p align="center"><img src="docs/screenshots/demo-sort.gif" width="300" alt="粘贴一段 Prompt，自动分进场景、镜头、画风、其他四栏"></p>

<p align="center">▶ <a href="docs/promo/nai-pocket-promo.mp4">观看 46 秒宣传片</a></p>

## 能做什么

### 写 Prompt 不再对着一长串英文
粘贴整段 Prompt，自动分成**场景 / 镜头 / 画风 / 其他**四栏。每个 Tag 是一块带中文释义的积木：点一下调权重，按住拖动排序，随时切回纯文本。多角色的站位在图上点选。

### 找画风
内置 **12,000+ 位画师**的资料库：按线条、上色、色调等画风维度筛选，看例图和逐图标注，收藏、写备注，一键加入画风。

### 找灵感
**法典**里看图挑配方；拿一张图**反推** Tag；从 PNG 里**还原**完整生成参数。

### 生成与管理
文生图、图生图、局部重绘、角色参考、Vibe Transfer 都在。任务进**后台队列**，可暂停、取消、重试；生成的图进入本机**图库**，搜索、收藏、一键恢复参数，并自动存一份到手机相册。常用设置存成**方案**，随时切换、导入导出。

### 官方账号或第三方中转
可以同时保存多个 NovelAI 官方 Token；也可以在「管理第三方中转」里添加 RBQ，或其他与 NovelAI 生图接口兼容的中转，生成时随时切换。中转返回的图片格式会自动识别。

<p align="center">
<img src="docs/screenshots/editor.png" width="200" alt="四栏 Tag 编辑">
<img src="docs/screenshots/helpers.png" width="200" alt="辅助功能">
<img src="docs/screenshots/codex.png" width="200" alt="法典">
<img src="docs/screenshots/artists.png" width="200" alt="画师资料库">
</p>

## 开始使用

1. 从 [Releases](https://github.com/MayRain-Meow/NAI-Pocket/releases/tag/v0.3.8-preview) 下载 APK 安装。
2. 打开设置添加账号：NovelAI 官方 Token，或在「管理第三方中转」里添加中转。
3. 写好 Prompt，点生成。

想看画师例图，在「设置 → 画师标注资料」里一键下载资料包即可。有新版本时，应用会自己提示更新。

## 常见问题

**要花钱吗？** 应用免费开源，生成用的是你自己账号的额度。

**隐私呢？** Token 加密保存在手机上，图库和方案也都在本机；生成请求直接发往你选择的渠道，应用本身不设服务器。

**遇到问题？** 欢迎提 [Issue](https://github.com/MayRain-Meow/NAI-Pocket/issues)。

## 开发者

构建、源码结构与测试见 [BUILD.md](BUILD.md)；手机调试见 [体验与调试说明](app/docs/REVIEW.public.md)；资料包格式见 [资料包说明](app/docs/ARTIST-PACK.public.md)。

## 许可

[AGPL-3.0-only](LICENSE) 开源。本项目与 NovelAI 官方无隶属关系；第三方服务与数据的署名见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
