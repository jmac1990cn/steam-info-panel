# Steam 游戏速查面板 · Chrome / Steam 客户端扩展

打开任意 Steam 商店游戏页时，在页面右侧自动插入一个信息面板，展示六项内容：

| # | 功能 | 数据源 | 说明 |
|---|------|--------|------|
| 1 | 史低价格 | **Steam 国区口径**：ITAD（需 key，取 Steam 档位 `storeLow`）→ 本地观测累积 → CheapShark（美元兜底） | 优先给出 Steam 国区史低，同时显示国区/美区当前价与折扣 |
| 2 | 家庭库是否已有 | **Steam 客户端本地文件**优先，网页登录态补充 | 区分「本人拥有」「家庭共享借入」「未拥有」 |
| 3 | DLC 是否单独下载 | Steam appdetails 的 dlc 列表 | 逐条列出 DLC，区分「原声/画集类独立下载项」与「随本体安装项」 |
| 4 | 是否在 XGP 会员库 | 内置 Game Pass 目录（631 款）+ 每周自动更新 | 本地离线比对，命中即显示匹配的目录名称 |
| 5 | 是否有 D 加密 | **Steam 商店页官方披露节点**（`div.DRM_notice`，零网络） | 直接读 Valve 强制发行商填写的「包含第三方 DRM: …」字段；无该节点即未披露。PCGamingWiki / SteamDB 仅在页面未就绪时兜底 |
| 6 | 是否在 Epic 免费过 | **ITAD 赠送记录**（IsThereAnyDeal，需自备 key） | 需在设置中填入自己的 ITAD API key（免费申请：<https://isthereanydeal.com/apps/my/>）。由 Steam appid 定位游戏身份，查 ITAD 该游戏的 Epic 历史赠送记录（覆盖 2018 年起每周喜加一）；判定 shop 是否为 Epic（新记录 `shop.id=16`、早期记录 `shop` 为 null 且标题含「Epic」）。命中即显示「曾免费 / 当前免费中 / 即将免费」+ 次数与时段，附领取链接。免登录 |

## 安装

### A. Chrome / Edge（推荐）

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启右上角「开发者模式」
2. 点击「加载已解压的扩展程序」，选择本目录 `steam-info-panel`
3. 打开任意 Steam 游戏页，例如 `https://store.steampowered.com/app/1196590/`

> ⚠️ **不要拖 `steam-info-panel.crx` 安装。** Chrome / Edge / Chromium 早已禁止非商店扩展的 crx 拖拽安装：它们会把 `.crx` 当**文件夹**去解析，读不到 manifest，于是报「清单文件缺失或不可读取 / 无法加载清单」（`Manifest file is missing or unreadable`）。这不是包损坏，是安装方式不对——一律用上面的「加载已解压」。
>
> **Linux / Steam Deck（桌面模式）**：如需压缩包，直接在本页点「Code → Download ZIP」下载仓库，解压后进入目录即可（仓库即源码，无需额外解包步骤）。也可用命令行 `google-chrome --load-extension=/home/deck/…/steam-info-panel` 启动。
>
> 本仓库**不含** `.crx` 打包产物与 `.pem` 打包私钥：`.pem` 用于保持同一扩展 ID，属私密文件，请自行保管、勿上传公开仓库。

### B. 复制到 Steam 客户端内使用

Steam 客户端基于 Chromium（CEF），可以通过插件框架挂载本扩展：

1. 安装 [Millennium](https://steambrew.app/) 与其扩展插件 **Extendium**
2. 打开扩展管理器：地址栏右侧拼图图标 → Manage extensions，或运行 `steam://extendium/manager`
3. 手动安装：把 `steam-info-panel` 目录完整复制到
   `{Steam 安装目录}/plugins/extendium/.extensions/steam-info-panel/`
   （`.extensions` 不存在就新建；内部文件夹名即扩展标识）
4. 完全重启 Steam 客户端

面板会显示在客户端内置浏览器打开的商店页右侧。Extendium 目前不支持 `chrome.alarms` 和 `chrome.tabs`，本扩展对此做了兼容：每周更新改为「唤醒/打开页面时按更新时间判断」，不依赖 alarm。

## 本地家庭库数据（离线判定，推荐配置）

在扩展选项页导入 Steam 客户端的两个本地文件后，即使不登录网页版，也能判定「本人拥有」与「家庭共享借入」：

| 文件 | 路径 | 作用 |
|---|---|---|
| `packageinfo.vdf` | `Steam\appcache\packageinfo.vdf` | 按 package 的 `owner` 字段区分本人与借入（**推荐，能识别家庭共享**） |
| `localconfig.vdf` | `Steam\userdata\<steamid>\config\localconfig.vdf` | 本人库中的 appid 清单 |

判定规则：把出现次数最多的 `owner` 视为本人 SteamID，其余 owner 名下的游戏标记为「家庭共享借入」。导入的数据保存在本地浏览器存储中，不会上传。

## 国区史低配置

- **精确国区史低**：在 [isthereanydeal.com/apps/my](https://isthereanydeal.com/apps/my/) 免费注册获取 API key（登录后进入 My Apps 创建应用即得），填入扩展选项页 → 该项显示 Steam 商店（`shop 61`）在中国区的历史最低价（ITAD 的 `storeLow`）
- **未配置 key**：插件会把每次访问时抓到的国区当前价记录下来，累积成「本地观测最低价」，并注明观测起始日期
- **美元口径兜底**：CheapShark 史低（含日期），面板中标注为非国区口径
- 若 Steam 在国区当前无在售（ITAD 不返回 Steam 档位），自动回退为「ITAD·全商店」史低并在面板标注，避免把第三方商店价误当成 Steam 史低

### ITAD 接口调用方式（v1.0.1 修正）

ITAD API v2 的取数是两步，**方法不能搞错**：

| 步骤 | 方法 | 端点 | 说明 |
|---|---|---|---|
| 1 | `GET` | `/games/lookup/v1?key=&appid=` | Steam appid → ITAD 游戏 UUID（返回 `{found, game:{id}}`） |
| 2 | `POST` | `/games/prices/v3?key=&country=CN&shops=61` | body 为 UUID 的 JSON 数组，返回 `historyLow`（all/y1/m3）与 `deals[]`（含 `price` / `storeLow` / `cut`） |

**405 排查**：`prices/v3`、`historylow/v1`、`storelow/v2` 等端点只接受 `POST`，用 `GET` 调用会返回 `405 Method Not Allowed`；`lookup/v1` 则是 `GET`。旧版代码还引用了不存在的 `/games/lowest/v2`（404）。v1.0.1 已全部改用正确链路。

**403 排查**：key 未填、无效或过期；少部分端点需要在 ITAD 后台申请额外授权。


## 面板内嵌设置（Steam 客户端等受限环境）

Steam 客户端（Millennium + Extendium，基于 CEF）**没有浏览器标签页**，点击「扩展程序选项」会让客户端闪退。
因此 v1.0.2 起把常用设置搬进了商店页的侧边面板：面板底部 **「⚙ 设置」** 可展开，内嵌提供

- ITAD API key 的填写与保存（走 `getSettings` / `setSettings` 消息，与选项页同一份数据）
- 一键清除全部缓存并重新检测
- 「完整设置页」入口（**仅浏览器环境可用**；CEF 下只给出提示，不尝试跳转）

同时 v1.0.2 移除了 `options_ui.open_in_tab`，避免在不支持标签页的宿主里走「新开标签页」这条路径。

> **Steam 客户端里请一律使用面板内的「⚙ 设置」，不要点击扩展的「选项」。**

## Game Pass 目录每周更新

- 插件内置 631 款目录（2026-09-15 抓取），开箱即用
- 每 7 天自动检查一次更新：Chrome/Edge 用 `chrome.alarms` 定时触发；Steam 客户端（无 alarms）在扩展唤醒或打开设置页时按更新时间判断
- 选项页可手动点击「在线更新目录」立即刷新（约 1–2 分钟，631 个产品 ID 分批换名）

## 已知局限

- **家庭共享**无 Steam 官方接口：本地 `packageinfo.vdf` 判定最准；仅靠网页时是综合推断
- **DLC 下载方式**为启发式判定：准确结论需看 SteamDB 的 DLC 页，确认该 DLC 的 depot 是否挂在本体 app 之下
- **XGP 目录**来自 Game Pass 主机全量目录，未单独区分 PC 阵容
- **D 加密**直读 Steam 商店页原生披露节点 `div.DRM_notice`（「包含第三方 DRM: Denuvo」）—— Valve 的官方字段，**零网络、零第三方依赖**（不再受 SteamDB 451 / PCGW 失败影响），浏览器与 Steam 客户端 CEF 同样有效。该节点不存在即表示 Steam 未披露第三方 DRM。仅当页面 DOM 未就绪时才降级到 PCGamingWiki / SteamDB 兜底。DRM 结果缓存 24 小时，换游戏或点「重新检测」清空缓存后才会重新判定
- 本地观测史低的准确性取决于你访问该游戏页的频次，早期可能偏高
- **Steam 客户端（CEF）里无法打开扩展选项页**：该环境没有浏览器标签页，点「扩展程序选项」会导致客户端闪退。请改用面板内的「⚙ 设置」（v1.0.2 起提供）
- 年龄分级游戏在未通过年龄验证时，商店页会先跳 `/agecheck/`，此时面板不注入（需先在页面完成年龄确认）

## 目录结构

```
steam-info-panel/
├── manifest.json          # MV3 清单
├── background.js          # 后台服务：跨域请求、VDF 解析、缓存、每周更新
├── content.js             # 页面注入与面板渲染
├── content.css            # 面板样式（Steam 深色风格）
├── xgp-catalog.json       # 内置 Game Pass 目录（631 条）
├── options.html / .js     # 选项页：缓存、ITAD key、本地数据导入、目录更新
└── icons/                 # 扩展图标
```

## 权限

- `storage`、`alarms`
- 跨域访问：`store.steampowered.com`、`api.steampowered.com`、`www.cheapshark.com`、`steamdb.info`、`www.pcgamingwiki.com`、`catalog.gamepass.com`、`displaycatalog.mp.microsoft.com`、`api.isthereanydeal.com`

缓存时效：价格 6 小时 · 库存 10 分钟 · DLC / GamePass 12 小时 · DRM 24 小时 · Epic 免费 24 小时 · Game Pass 目录每 7 天更新。
