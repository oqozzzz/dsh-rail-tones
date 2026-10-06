# dsh-rail-tones

会话导航条音效 —— 为 DeepSeek Harness Web GUI / DSH Desktop 复刻「在会话导航条上竖向滑动或点击刻度时，播放音阶提示音」这一功能。

- **音高 = 位置**：导轨内容位置 0→1 映射到大调五声音阶 2 个八度（A3…F#5，10 个音级），越高越靠后。
- **四种触发**：光标沿导轨竖向划过（**不需要按键**）、按住拖动、点击刻度、在导轨上滚轮翻阅。
- **零素材、零依赖、零宿主服务**：Web Audio 实时合成；不 require 任何 `@deepseek-ai/*` 客户端包；宿主半边为空。
- **只读观察**：只用 `document` 上的捕获阶段 + `passive` 委托监听，不写 DOM、不 `preventDefault`、不 `stopPropagation`，官方跳转 / 悬停预览 / 键盘聚焦行为完全不变。

当前版本 **v0.1.12**；版本历史见 [CHANGELOG.md](CHANGELOG.md)。

## 安装

```powershell
# <DSH 安装目录> = DeepSeek Harness 的安装位置，CLI 在其 resources\runtime\cli\bin\dsh.cmd
#                 （该 bin 已在 PATH 里的话，直接写 dsh 即可）
# <插件目录>     = 本仓库在你机器上的绝对路径
& '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add link:<插件目录>
```

安装后**重启 DSH Desktop**（插件名单在实例启动时读取）。

## 使用

1. 打开任意会话（真实提问 ≥ 2 轮才会出现官方导轨）。
2. **光标沿导航条竖向划过**（不按键）→ 随位置发声；按住拖动同理。
3. 点击某个刻度 → 发出该刻度对应的音（跳转行为不变）。
4. 指针停在导轨上滚动滚轮 → 刻度滚动经过指针时发声。
5. **设置 → 导航条音效**：开关、音量（**0–200%**，v0.1.12 起上限由 100% 提到 200%，下限 0）、试听。开关关闭后立即生效（试听同样静音）。

**音符以「刻度」为单位**：事件先吸附到指针所在（或最近）刻度的中线，再换算音高。
因此同一个刻度上，光标划过、按住滑动、点击、滚轮得到的是**同一个音**。

**同一个音级只响一次**：音高把整场会话分成 10 档（2 个八度五声音阶）。只要指针还在
同一档里 —— 哪怕手抖出几十个 `pointermove`、哪怕宿主在重渲染、哪怕刻度节点被虚拟
滚动回收 —— 都不会再发声；只有音级变化、或做出**明确手势**（按下 / 键盘回车激活）
才会再响一声。指针离开导轨超过 0.3 秒后再次划入同一音级，会重新发声。

两道防抖保险（v0.1.9）：

- **刻度吸附滞回**：相邻刻度必须「明显更近」（4px 余量）才切换，指针在相邻刻度分界线
  上抖动不会来回跳档；
- **离开延迟确认**：任何「指针离开导轨」的信号（包括宿主重渲染导致的瞬时异常目标、
  蹭到悬停预览气泡）都要持续满 300ms 才清空去重锚点 —— 瞬时抖动不再被误判成
  「离开后又进入」而重放同一音。

> 这也意味着：会话很长时，一个音级覆盖很多个刻度，同一档内滑动是安静的 —— 这是
> 「音高表示会话位置」的必然结果，不是丢音。

> 音频上下文需要一次用户手势才会启动：第一次点击/按键之后，纯划过（悬停）才有声音；
> 在此之前划过是静音的（浏览器自动播放策略，非故障）。

### 改动后如何生效

`client.js` 是手写的客户端产物，没有构建步骤。宿主在**实例启动时**对每个 `client.js`
做快照并按下发版本号（`mtime/ctime/size`）提供；HMR 只在这一行被重新发布后才换 URL。
所以改完 `client.js` 之后：

1. 先刷新页面试试；
2. **没变化就重启 DSH Desktop**（最可靠）；
3. 用 **设置 → 导航条音效** 卡片右下角的 `dsh-rail-tones vX.Y.Z`，或
   `__dshRailTones.status().version` 确认浏览器里真正跑的是哪一版 —— 版本号没变就说明
   新产物还没下发，此时讨论行为没有意义。

## 验证

```powershell
# 语法与单元测试（纯逻辑 + 清单契约）
node --check client.js
node --check index.js
node --test test/

# 宿主是否已收录该客户端行：`dsh plugin` 是否写入了依赖与 bundle
Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Pattern 'dsh-rail-tones'

# 插件自报（宿主半边注册的只读路由，无需 DevTools、无需页面）
curl.exe -s http://127.0.0.1:19387/rail-tones/status
Get-Content "$env:USERPROFILE\.dsh\rail-tones-report.json" -Raw
```

`/rail-tones/status` 的返回直接回答「重启后插件到底有没有起来」：

- **404** —— 这一行在启动时**根本没有被组装**（插件没加载，跟卡片注册无关）；
- **200 + `report: null`** —— 宿主半边起来了，但浏览器半边还没上报（客户端没挂载）；
- **200 + `report`** —— 浏览器半边挂载了，看这几个字段：
  - `settingsFailure` —— `registerSettingsSection()` **整体抛异常**时的异常原文（含栈顶三行）；
  - `settings.react` / `settings.reactError` —— 取 React 是否成功、失败原文；
  - `settings.slots` / `settings.error` —— `ctx.slots` 是否就绪 / 具体错误；
  - `settings.injected` / `settings.registered` —— 槽位注入与卡片注册的结果；
  - `settings.retriesLeft` —— 还在重试时剩余次数；
  - `report.payload.reason` —— 这次上报的触发点：`mount` / `settings-registered` /
    `settings-threw`（注册链抛错，仅首次失败报一次）/ `settings-failed` / `settings-gave-up`（重试耗尽）/ `manual`；
  - `rails` —— 当时识别到的导轨（未接触过导轨时为空数组）。

> 三者互斥地指向不同的修复方向：`settingsFailure` 非空 = 注册流程本身炸了；
> `settings.react === false` = 拿不到 React；`settings.slots === false` = 服务还没就绪；
> `injected: true, registered: false` = 槽位在但注册被拒。

> 浏览器半边挂载时、以及槽位注册成功/失败时都会自动上报一次；
> `__dshRailTones.report('手动')` 可随时再报一次。
> 这两条路由只读、只在本机回环上、只服务于诊断；`~/.dsh/rail-tones-report.json` 删掉也无影响。

> 注意：`dsh web` 对未认证请求返回 `401`（“dsh web authentication required”）的路由是页面与
> 应用接口；插件自己注册的路由不在那道栅栏内，可以直接 curl。

浏览器 DevTools 控制台：

```js
__dshRailTones.status()
// { version, instances, enabled, volume, notesPlayed, lastNoteHz, lastTick,
//   railSeen, audioState,
//   settings: { registered, attempts, error },
//   dedup: { accepted, skippedByDegree, lastDegree, lastTickIndex,
//            lastPosition, lastSkip, resets, lastReset, offRailPending, railKnown } }
__dshRailTones.log(10)        // 最近 10 次真正发声：{ at, hz, source, tick, degree }
__dshRailTones.rails()        // 页面上每个「含刻度按钮的 nav」→ { used, ticks, width, height }
__dshRailTones.play(0.5)      // 手动发一声（会话中段）
__dshRailTones.setEnabled(false)
__dshRailTones.setVolume(0.3)
```

排查时看这几处：

- `version` / 设置卡片右下角的版本号 —— 不是最新版就说明新产物还没下发（重启 DSH Desktop）；
- `instances` —— 正常为 `1`（挂载时会主动销毁上一份残留实例）；
- `settings.registered` —— 设置卡片没出现时看这里：`false` + `error` 就是槽位注册失败的原因；
- `dedup` —— 抖动时 `skippedByDegree` 应持续增长而 `notesPlayed` 不动；`resets` 应保持为 0
  （>0 说明去重锚点被清过，`lastReset.reason` 指明是哪条路径清的）。

`railSeen: false` 说明还没命中过导轨（会话轮次不足或指针未接触导轨）。
`rails()` 里 `used: false` 的条目是**被排除**的 nav（例如恰好也是 `<nav>` 的外层包裹元素）——
它们不会发声；如果这里出现了两条 `used: true`，说明界面上确实有两条导轨（例如同屏两个会话视图）。

## 实现要点

| 关注点 | 做法 |
|---|---|
| 刻度识别 | `nav` 内含 `button[data-index]`（官方 TurnMark），不依赖任何哈希 CSS 类名 |
| 槽位服务时序 | 客户端这一行在组合脚本里排在前面，`apply` 执行时 **`ctx.slots` 可能是 `undefined`**（模块级 `inject: ['slots']` 在客户端这条路径上不保证等到服务就绪）；`ctx.get('locale')` 未就绪时返回的也是 **undefined 而不是 null**，所有服务判定必须同时挡住两者（v0.1.9 只判 `!== null`，2026-10-06 实盘炸过一次）。因此用 `ctx.inject(['slots'], cb)` 作用域注入等服务就绪，且**任何失败（`slots === false` 或整条抛错）都按 400ms × 最多 60 次有界重试**，放弃时报 `settings-gave-up` |
| 导轨唯一性 | 只认**直接拥有刻度**的 nav（`tick.closest('nav') === nav`）：外壳恰好也是 `<nav>` 时不会把它当成第二条导轨，避免整块面板乱发声 |
| 刻度吸附 | 所有触发都先 `tickAt(nav, y)` 取指针所在/最近的刻度，用**刻度中线**换算位置 → 同一刻度上四种手势得到同一个音；另加 4px **滞回**：另一个刻度明显更近才切换，分界线抖动不跳档 |
| 触发方式 | `pointermove`：光标划过（hover，**不需要按键**）与按住拖动都发声；`pointerdown`：点击发声；`click.detail === 0`：键盘激活发声；`wheel`：滚动停止 90ms 后取离指针最近的刻度 |
| 预览气泡 | hover 只在导轨滚动条区域内发声（`scroller.contains(target)`），鼠标移到刻度预览气泡上时不发声；且「离开导轨」统一走 300ms **延迟确认**才清去重锚点，重渲染瞬时异常 / 蹭气泡不会导致重放 |
| 滚动容器缓存 | `WeakMap<nav, scroller>`：命中一次后复用，避免高额 `pointermove` 触发 `getComputedStyle` 遍历 |
| 位置换算 | 刻度祖先中唯一的可滚动元素（`overflow-y:auto` 且 `scrollHeight > clientHeight`）作为虚拟滚动容器，`(y - rectTop + scrollTop) / scrollHeight` |
| 虚拟滚动 | 不缓存刻度节点，每次事件重新查询；滚动时 `data-index` 只用于宿主自身渲染 |
| 音高映射 | `degree = round(position × 9)`，`hz = 220 × 2^((SCALE[d%5] + 12·⌊d/5⌋)/12)`，`SCALE = [0,2,4,7,9]` |
| 合成 | 单个 `sine` 振荡器 + 6ms 线性起音 + 180ms 指数衰减，峰值 = 音量 × 0.22 |
| 节奏控制 | **闸门 = 音级**：`degree` 没变就不发声。指针停在原处（哪怕抖出几十个 `pointermove`、哪怕宿主重渲染、哪怕刻度节点被虚拟滚动回收）都不会重复响；音级变了才响，离开导轨后再划入同一音级也会响。另有最小间隔 70ms。**注意**：监听层靠 `env.signal()` 的返回值更新锚点，适配器必须 `return controller.signal(...)` —— v0.1.11 修掉了这里漏掉的 `return`：此前锚点从不更新，这道闸门自 v0.1.5 引入起就是死的 |
| 明确手势 | `pointerdown`（按下）与键盘激活（`click.detail === 0`）带 `repeat`：即使与上一声同音级也再响一次作为确认，仍受 70ms 最小间隔约束（v0.1.10 起 `repeat` 才真的透传到调度器；此前在 `apply` 的适配器里被丢掉，250ms 内的点击是静音的） |
| 槽位注册 | `slots.register()` 在槽位**尚未被父级声明**时会抛错（`slot "…" is not declared`）。启动早于设置页时不能一次注册就放弃：内层按 400ms 有界重试（inject 45 次、register 12 次），成功即停，owner 折叠时清定时器；结果记在 `status().settings`。**`status.error` 只在注册成功时清空** —— 失败原文若被后续步骤覆盖，自报里就只剩 `registered:false`，无从定位（v0.1.9 踩过） |
| 单实例 | 市场禁用/启用走**热挂载**（不刷新页面）。挂载前先 `dispose()` 掉 `window.__dshRailTonesActive` 上残留的上一个实例，避免同一指针动作被多份监听各响一遍 |
| 自证 | `status()` 暴露 `version / instances / settings{registered,attempts,error,retriesLeft} / dedup{…}`；`log()` 返回最近 20 次发声明细；设置卡片右下角显示版本号；宿主半边提供 `GET /rail-tones/status` + `POST /rail-tones/report`（并镜像到 `~/.dsh/rail-tones-report.json`），让「启动时到底有没有挂载」在终端可读 |
| 自动播放策略 | 首次 `pointerdown`/`keydown` 预热 `AudioContext`；`state !== 'running'` 时尝试 `resume()`，失败即静默 |
| 生命周期 | 监听器、定时器、音频上下文全部在 `ctx.effect` 内注册并在卸载时清理 |
| 失败模式 | 任何异常只 `console.warn` 一次；导轨结构变化时软降级为无声，不影响宿主 |

## 设置与存储

设置项存 `localStorage['dsh-rail-tones:v1'] = {"enabled":true,"volume":0.5}`（每个浏览器各自一份；隐私模式下退化为仅本次会话有效）。存储不可用或内容损坏时回退到默认值，绝不抛错。

**音量范围**：`0 … 200%`（`MAX_VOLUME = 2`，上限即原来 100% 的 2 倍；下限 0）。
读取、写入、`__dshRailTones.setVolume()`、滑杆四处都按同一上限钳制，存量里越界的旧值读取时会被钳到新上限。
包络峰值为 `音量 × 0.22`，因此 200% 时是 0.44，仍在满幅之内、不会削波。

## 卸载

```powershell
& '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop remove dsh-rail-tones
```

删除后重启 DSH Desktop 即完全恢复原状（无残留文件、无宿主配置）。

## 项目结构

| 文件 | 说明 |
|---|---|
| `client.js` | **全部功能**：手写客户端产物，无构建步骤 |
| `index.js` | 宿主半边：只做两条只读诊断路由（`/rail-tones/status`、`/rail-tones/report`） |
| `test/rail-tones.test.mjs` | `node --test` 用例：纯逻辑、清单契约、设置注册、监听层与 apply 级接线 |
| `package.json` | `dsh.bundle.patch` + `dsh.client{platform:'web', immediately, inject}` + `./client` 导出；零依赖 |
| `cordis.patch.yml` | 向 profile 的配置树插入本插件那一行 |
| `CHANGELOG.md` | 版本历史 |

改动 `client.js` 后如何生效，见上文 [改动后如何生效](#改动后如何生效)。

## 已知边界

- 开发与验证环境为 DSH Desktop `0.2.0-rc.2`（Electron 44 / Chromium 152）；其它宿主版本不保证。
- 会话真实提问少于 2 轮时官方不渲染导轨，此时不会有任何声音（设计如此）。
- 滚轮发声在音频上下文尚未被用户手势激活时会静默跳过（浏览器自动播放策略）。
- 音色为合成正弦；如需更换音色，只改 `client.js` 里的音色参数即可。
- 与官方导轨的耦合点是「`nav` + `button[data-index]` + 可滚动祖先」这三个语义特征；DSH 未来大改版会让插件无声降级（不报错）。

## 许可

MIT，见 [LICENSE](LICENSE)。
