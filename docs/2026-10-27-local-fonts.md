# Zero 本地字体来源与分发说明

页面使用真实自托管字体，运行时不请求 Google Fonts、Fontsource 或其他第三方字体服务。字体文件位于 `web/public/fonts/`，字体声明位于 `web/src/fonts.css`。

## 字体与体积

| CSS 字族 | 字体 | 字重与样式 | WOFF2 文件数 | 二进制总字节数 |
| --- | --- | --- | ---: | ---: |
| `Zero Sans` | Noto Sans SC | 100–900 可变字重，正常体 | 102 | 4,516,584 |
| `Zero Serif` | Noto Serif SC | 200–900 可变字重，正常体 | 102 | 6,051,944 |
| `Zero Display` | Instrument Serif | 400 正常体及斜体 | 4 | 67,148 |
| `Zero Mono` | JetBrains Mono | 100–800 可变字重，正常体 | 6 | 86,244 |
| 合计 | | | 214 | 10,721,920 |

字体二进制总计约 **10.23 MiB**，不是首屏下载量。两套中文字体保留上游 `unicode-range` 分片，浏览器只请求当前文字使用的分片；同一分片的可变字重无需再下载多套静态字体。不要预加载全部中文分片。这里只分发 WOFF2，没有同时携带 TTF、WOFF 或不使用的等宽斜体。

`Zero Sans` 用于中文正文、导航及表单；`Zero Serif` 用于中文标题；`Zero Display` 用于较大的 Latin 字标和编辑式标题；`Zero Mono` 用于代码、路径、时间及技术标识。CSS 提供 `--zero-font-sans`、`--zero-font-serif`、`--zero-font-display`、`--zero-font-mono` 四个组合栈。

## 中文覆盖与回退

中文基础分片来自完整的 Fontsource 默认分发，未按当前截图或页面文案裁字。核验实际 WOFF2 `cmap` 及 CSS 字符路由时，发现该上游分发缺少 GB2312 二级汉字中的 33 字。

为两个中文字族各补充一份由 Google Fonts 官方生成的标准字集缺口分片，合计仅增加 **36,996 字节**。补充集依据固定 GB2312 字表计算，与当前页面展示什么文字无关：

```text
劐阢坶塥蒈蓰猸弪艴骣桊轷戤赇牿犋毪胲脶膪憝铴镩稆瘭耠耢耥蟓筢蹯鲰齄
```

最终两套中文字体都具备 **6,763 个 GB2312 汉字的实际非零字形**，包括全部 3,755 个一级汉字及 3,008 个二级汉字。计入其他文字、符号和扩展汉字后，CSS 实际可路由的码位分别为 13,666（Sans）和 13,697（Serif）。这不等于覆盖所有 Unicode 汉字；字库未收录的罕见扩展字、emoji 等仍交由组合栈中的系统字体处理。

所有 `@font-face` 均使用 `font-display: swap`，字体加载期间保留可读回退；已经收录的字形不依赖用户电脑是否安装这些字体。

## 固定来源与许可证

四套字体均按 **SIL Open Font License 1.1（OFL-1.1）** 分发。每个字体子目录同时保留：

- `OFL.txt`：Fontsource 包中原始许可证，未经改写。
- `UPSTREAM-OFL.txt`：Google Fonts 上游完整版权及许可证，保留 Noto 的 Adobe 版权和 Reserved Font Name 声明；来源 Git blob SHA 见清单。
- `metadata.json`：Fontsource 原始元数据。

字体二进制没有改动。`Zero …` 仅为 CSS 中的应用字族别名，没有修改字体文件内部名称、版权或保留字名。

| 字体 | 固定 Fontsource 包 | 官方字体及许可说明 | 上游许可 |
| --- | --- | --- | --- |
| Noto Sans SC | `@fontsource-variable/noto-sans-sc@5.3.1` | [Fontsource](https://fontsource.org/fonts/noto-sans-sc/about) | [Google Fonts OFL](https://github.com/google/fonts/blob/main/ofl/notosanssc/OFL.txt) |
| Noto Serif SC | `@fontsource-variable/noto-serif-sc@5.3.1` | [Fontsource](https://fontsource.org/fonts/noto-serif-sc/about) | [Google Fonts OFL](https://github.com/google/fonts/blob/main/ofl/notoserifsc/OFL.txt) |
| Instrument Serif | `@fontsource/instrument-serif@5.3.0` | [Fontsource](https://fontsource.org/fonts/instrument-serif/about) | [Google Fonts OFL](https://github.com/google/fonts/blob/main/ofl/instrumentserif/OFL.txt) |
| JetBrains Mono | `@fontsource-variable/jetbrains-mono@5.3.0` | [Fontsource](https://fontsource.org/fonts/jetbrains-mono/about) | [Google Fonts OFL](https://github.com/google/fonts/blob/main/ofl/jetbrainsmono/OFL.txt) |

Fontsource 包从 npm 官方 registry 的固定版本归档下载，下载后先核对 registry 声明的 SHA-512 integrity 再提取。标准字集补充分片从 `fonts.googleapis.com` 查询并从 `fonts.gstatic.com` 下载；生成时的完整查询 URL、返回文件 URL、原 CSS 哈希均记录在清单。下载服务只用于准备资源，产品运行不连接这些域名。

## 可审计清单与验证

`web/public/fonts/MANIFEST.json` 记录每个分发文件的原 URL、包版本、归档内路径、字节数及 SHA-256，也记录归档 integrity、上游许可证 Git blob SHA 和 CSS SHA-256。重新分发或更新字体时应保留许可证并更新该清单。

`web/public/fonts/VERIFICATION.json` 记录本次离线检查结果：

- 226 个来源文件的大小与 SHA-256 全部匹配。
- 214 个 WOFF2 的签名、声明长度、Brotli 数据及 Unicode `cmap` 均成功读取。
- 两个中文字族逐字核对 GB2312 汉字的实际非零字形，并同时确认 CSS `unicode-range` 能路由到对应文件，缺字数均为 0。
- 214 条字体声明全部使用同源 URL 和 `font-display: swap`，样式中没有第三方 URL 或远程 `@import`。

资源验证不代替浏览器渲染检查；页面集成还应检查浏览器实际选用的字体、请求状态及视觉表现。
