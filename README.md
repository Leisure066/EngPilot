# EngPilot

离线优先的 CET-6 背单词桌面应用。词库、词典、记忆曲线全部跑在本地，断网可用，
没有账号，不上传任何数据（初始项目名为“斩词”）。

![首页](docs/ui-home.png)

## 功能

- **2,084 个 CET-6 单词**，每天 20 个，先回忆、后揭晓
- **SM-2 记忆曲线**：四档评分（忘了 / 勉强 / 记得 / 太简单），自动排下一次复习
- **340 万条离线词典**：音标、词形变化、柯林斯星级、词缀拆解
- **中英文搜词**：输入「放弃」这种中文，也能找到 `repeal`
- **笔记、星标、30 天统计**
- **Windows 桌面壳**：WPF + WebView2 无边框窗口，托盘常驻，单实例

| 复习 | 统计 |
| --- | --- |
| ![复习](docs/ui-review.png) | ![统计](docs/ui-stats.png) |

## 快速开始

### 直接下载

[Releases](../../releases) 里的 zip 是完整包（含词典和数据库），解压双击 `EngPilot.exe`。

> 程序没有数字签名，首次运行可能被 Windows SmartScreen 拦一下。
> 点「更多信息 → 仍要运行」，或者双击包里的 `启动 EngPilot.bat`（先清网络标记再启动）。

### 从源码跑

需要 Node.js **22.5 以上**（用到内置的 `node:sqlite`）。零依赖，不用 `npm install`：

```bash
npm start          # 打开 http://127.0.0.1:5188
```

首次启动会用 `data/words.seed.json` 建库，得到 2,084 个单词。

### 补上离线词典（可选）

仓库里没有那个 380 MB 的词典库。需要完整查词时：

1. 从 [ECDICT](https://github.com/skywind3000/ECDICT) 下载 `stardict.csv`，放进 `stardict/`
2. 运行 `npm run import:dict`

不装也能正常背单词，只是查词时只有词书里的内容。

### 编译桌面壳

需要 .NET 10 SDK：

```bash
dotnet publish desktop/Zhanci.App/Zhanci.App.csproj -c Release -r win-x64 \
  --self-contained true -o dist/EngPilot
```

发布出来的壳会去自己旁边找 `node.exe`、`server/`、`public/`、`data/`，这几样要一起放进去。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 后端 | Node.js 24 + `node:sqlite`，零 npm 依赖 |
| 前端 | 原生 HTML / CSS / JS，零构建、零 CDN，逻辑都在一个 `public/app.js` |
| 桌面 | WPF + WebView2，.NET 10，自包含发布，用户不用装运行时 |

## 项目结构

```
server/              后端：HTTP 路由、SQLite、导入解析、SM-2 复习
public/              前端：index.html + app.js + styles.css
desktop/Zhanci.App/  桌面壳（WPF + WebView2）
data/
  words.seed.json    词表种子（2,084 词），首次启动据此建库
  zhanci.db          运行时数据库，生成物，已在 .gitignore 排除
scripts/             建库、导入词典、冒烟测试
docs/                截图
```

> 桌面壳目录沿用早期代号 `Zhanci.App`，C# 命名空间仍是 `Zhanci.*`——
> 历史原因，改名要动十几个文件的 `x:Class`，不值当，就没改。

## 数据与隐私

- 学习状态、笔记、复习记录全在一个 SQLite 文件 `data/zhanci.db` 里，复制它就能备份
- 界面设置（壁纸、音量）在 `%LOCALAPPDATA%\EngPilot`；那里不可写时自动回退到程序目录的 `.userdata`
- 除了「在线壁纸」，没有任何网络请求

## 快捷键

| 键 | 作用 |
| --- | --- |
| `/` | 聚焦搜索栏 |
| `↑` `↓` | 切换搜索结果，`Enter` 打开 |
| `Space` | 揭晓释义 |
| `1` | 不认识（标记为学习中） |
| `2` / `Enter` | 认识（标记为已掌握） |
| `1`–`4` | 复习页四档评分 |
| `Esc` | 关闭弹层 / 退出学习 |

## 开发

```bash
npm run smoke            # 51 项冒烟测试，用独立测试库，不碰你的数据
npm run build:db         # 建库 / 补库
npm run build:db:reset   # 删库重建（会清掉离线词典，之后要重新 import:dict）
```

前端改完刷新页面即可，不用构建。桌面壳加载的是 `dist/EngPilot/public/`，
所以改 `public/` 之后要同步过去再重启。

## 许可证

代码以 [MIT](LICENSE) 许可开源。

数据不在此列：

- 离线词典来自 [ECDICT](https://github.com/skywind3000/ECDICT)，遵循其 MIT 许可
- CET-6 词表整理自公开的六级词汇表，仅供学习交流；如权利人认为不妥，请联系删除
- 在线壁纸由夜轻的公益 API 随机提供，插画版权归原作者；可在设置里关掉或换成本地图片

## 致谢

- [ECDICT](https://github.com/skywind3000/ECDICT) —— 离线英汉词典数据
- [WebView2](https://learn.microsoft.com/microsoft-edge/webview2/) —— 桌面壳的浏览器内核
- [夜轻](https://www.yeqing.net/)（[Yeqingky](https://github.com/Yeqingky)）—— 公益随机壁纸 API
  （`api.yppp.net`），默认背景图来自这里