---
description: "面向 DeepSeek Harness web 接缝（ctx.web）的 fake-ip 感知 WebFetchProvider：在 mihomo/Clash TUN 模式 + fake-ip DNS 下让 web_fetch 工具继续可用，无需关闭 fake-ip，也无需设置任何代理环境变量。"
kind: "package-reference"
---

# dsh-web-fetch-fakeip

[English](README.md) | 中文

`@deepseek-ai/dsh-web-fetch-http` 的直接替代品：当本机 DNS 处于 **fake-ip**
模式、且网络走透明代理（TUN）时，让 `web_fetch` 工具继续可用——fake-ip 保持
开启，且**不需要**设置 `http_proxy` / `https_proxy` / `all_proxy`。

## 摘要

`dsh-web-fetch-http` 会自行解析每个主机名，并要求所有应答都是公网 unicast
地址，否则拒绝请求。而在 fake-ip 模式下，mihomo 与 Clash 会用
`dns.fake-ip-range`（默认 `198.18.0.1/16`）中的占位地址应答**每一个**主机名。
`ipaddr.js` 把 `198.18.0.0/15` 归类为 `reserved`（RFC 2544 基准测试段），因此
原版 provider 会拒绝所有主机名：

```text
Error: URL hostname "example.com" resolves to a non-public IP address
```

`curl` 等工具不受影响，因为它们根本不做这项校验：它们把包发往占位地址，TUN
网卡截走并交给代理，由代理解析真实源站。原版 provider 的代理逃生通道同样无效，
因为 `proxyRouteFor()` 只读 `http_proxy` / `https_proxy` / `all_proxy`，而 TUN
方案一个都不需要设。

本插件完整复用原版 provider 的传输层，**只**替换目的地判定策略。

## 目录

- [快速开始](#快速开始)
- [示例配置](#示例配置)
- [配置项](#配置项)
- [改变与不改变的行为](#改变与不改变的行为)
- [诊断你的环境](#诊断你的环境)
- [工作原理](#工作原理)
- [开发](#开发)
- [安全说明](#安全说明)
- [已知限制](#已知限制)
- [许可证](#许可证)

-----

<a id="快速开始"></a>
## 快速开始

### 安装到 profile

```sh
# 在包含本仓库的目录下执行。相对路径以你当前所在目录为基准，而非 profile。
dsh plugin --profile web add /path/to/dsh-web-fetch-fakeip
```

由于本包在 `package.json` 中声明了 `dsh.bundle`，`dsh plugin` 会自动把它加入
`dsh.profile.bundles`，并把它的 [`cordis.patch.yml`](cordis.patch.yml) 作为一层
应用：禁用原版 `web-fetch-http` 行，插入本 provider。

重启 profile（或等 `patchReload: live` 监听器生效）后，`web_fetch` 即可恢复。

### 手动安装

若不想安装为包，可把目录复制进 profile，再用 patch 行指向文件：

```sh
cp -r dsh-web-fetch-fakeip "$DSH_HOME/profiles/web/plugins/"
```

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: web-fetch-http
  disabled: true

- insert:
    - id: web-fetch-fakeip
      name: './plugins/dsh-web-fetch-fakeip/src/index.js'
```

patch 会整体替换目标行的 `config`；匹配不到任何行的 patch 只会告警并被跳过，
所以即使原版行不存在，上面的 `disabled: true` 也是安全的。

### 验证

```sh
# 应打印出组合结果：web-fetch-http 已禁用，web-fetch-fakeip 已插入。
dsh --profile web --dump-config | grep -A3 fakeip
```

随后让 agent 抓取一个页面，或直接跑真实网络测试：

```sh
npm run test:live
```

**安装或卸载 bundle 后必须重启。** profile 的 `patchReload: live` 监听器只会
重新读取 `cordis.patch.yml`；而 `dsh.profile.bundles` 列表只在启动时读取一次。
安装 bundle 会立刻把它写入该列表（因此 `--dump-config` 能看到），但正在运行的
host 会一直沿用启动时的层栈，直到重启。

### 卸载

```sh
dsh plugin --profile web remove dsh-web-fetch-fakeip
```

`dsh plugin` 会在 pnpm 结束后核对 `dsh.profile.bundles`，因此该 bundle 层会随
依赖一起离开层栈。之后重启 profile。原版 `web-fetch-http` 行会自动恢复——那条
禁用来自本 bundle 的 patch，所以移除 bundle 也就移除了禁用。

### 更新

```sh
dsh plugin --profile web update dsh-web-fetch-fakeip
```

不带 ref 的 `github:` 说明符跟踪仓库的默认分支，pnpm 在安装/更新时才解析它——
因此更新是显式的，绝不会静默发生。

-----

<a id="示例配置"></a>
## 示例配置

### 常见情形：mihomo/Clash 默认网段

无需任何配置——每个字段的默认值都与原版 provider 一致。随包提供的
[`cordis.patch.yml`](cordis.patch.yml) 就是这样做的：

```yaml
- id: web-fetch-http
  disabled: true

- insert:
    - id: web-fetch-fakeip
      name: 'dsh-web-fetch-fakeip'
```

显式写出的版本见
[`examples/mihomo-default.patch.yml`](examples/mihomo-default.patch.yml)。

### 非默认的 `dns.fake-ip-range`

把 `fakeIpRanges` 改成代理实际写入的网段，否则 fake-ip 主机名仍会失败：

```yaml
- id: web-fetch-http
  disabled: true

- insert:
    - id: web-fetch-fakeip
      name: 'dsh-web-fetch-fakeip'
      config:
        fakeIpRanges:
          - 10.18.0.0/16
          - 198.18.0.0/15
```

允许配置多个网段；只要一组应答中的每个地址都落在**某个**已配置网段内，该组应答
就被接受。这个例子加上收紧的传输限制见
[`examples/custom-range.patch.yml`](examples/custom-range.patch.yml)。

### 查询代理的实际网段

| 代理 | 配置键 |
| --- | --- |
| mihomo / Clash / Clash Verge | `dns.fake-ip-range` |
| sing-box | `dns.fakeip.range` |

对 GUI 客户端而言，实际生效值在**生成的运行时配置**里，而不是订阅配置里——到
客户端自己的配置目录中查找上表中的键，并确认 `enhanced-mode` 为 `fake-ip`：

```yaml
dns:
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
```

`scripts/diagnose.mjs` 会直接读回 DNS 的实际应答，因此你不必找到那个文件也能知道
该配置什么。

-----

<a id="配置项"></a>
## 配置项

每个字段的默认值都与原版 provider 一致，因此不带 `config:` 挂载本插件时，改变的
只有一件事：目的地如何判定。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `fakeIpRanges` | `['198.18.0.0/15']` | 可作为 fake-ip 应答接受的占位地址段 |
| `maxResponseBytes` | `5000000` | 响应体最大字节数 |
| `maxBodyChars` | `100000` | 解码后正文最大字符数 |
| `timeoutMs` | `30000` | 抓取超时——资源兜底，不是工具预算 |
| `maxRedirects` | `5` | 同源重定向最大跳数（`0` 表示不跟随） |
| `userAgent` | `deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)` | 每个请求发送的 `User-Agent` |

非法值会在插件构造时直接报错，而不是构造出一个限制值荒谬的 provider——与原版
provider 一致。URL 长度上限固定为 2048 字符。

### 为什么默认是 `198.18.0.0/15` 而不是 `198.18.0.1/16`

mihomo 的文档默认值是 `198.18.0.1/16`，它是 `198.18.0.0/15` 的子集。较宽的
网段正是 RFC 2544 基准测试段整体，因此默认值同时覆盖两种写法以及部分配置使用的
相邻网段。若你希望更严格，收窄到 `/16` 是安全的。

-----

<a id="改变与不改变的行为"></a>
## 改变与不改变的行为

| 目的地 | 行为 |
| --- | --- |
| 主机名，其应答**全部**是 fake-ip 占位地址 | **接受**，原样固定连接；连接抵达 TUN 网卡，由代理解析真实源站 |
| 主机名，解析为公网 unicast | 接受，与原版 provider 完全一致 |
| 主机名，解析为内网 / 环回 / 保留地址 | **拒绝**（`WEB_BLOCKED_URL`），与原版完全一致 |
| 主机名，应答**混合**（占位地址 + 任何真实地址） | **拒绝**——绝不部分接受 |
| IP **字面量**且落在占位网段内（`http://198.18.0.100/`） | **拒绝**——字面量本身指明了目的地，绝不走 fake-ip 路径 |
| IP **字面量**且为内网/环回/链路本地（`127.0.0.1`、`192.168.1.1`、`169.254.169.254`、`10.0.0.1`、`[::1]`） | **拒绝** |
| IP **字面量**且为公网（`1.1.1.1`） | 经正常校验路径接受 |

其余行为全部原样继承自原版 provider：仅同源重定向、字节与字符上限、
`Content-Type` 分类、按 `Content-Type` 头解码字符集、拒绝二进制类型与含凭据的
URL，以及相同的 `WebError` 错误码（`WEB_INVALID_URL`、`WEB_BLOCKED_URL`、
`WEB_FETCH_TOO_LARGE`、`WEB_FETCH_TIMEOUT`、`WEB_REDIRECT_BLOCKED`、
`WEB_UNSUPPORTED_CONTENT_TYPE`、`WEB_ABORTED`、`WEB_PROVIDER_ERROR`）。

-----

<a id="诊断你的环境"></a>
## 诊断你的环境

先运行随包诊断脚本——它能把三种从报错信息看起来一样的情形区分开。作为 bundle
安装时，请通过包来解析其路径，这样无论 pnpm 把它放在哪里都能用：

```sh
# 在 profile 目录下执行（即安装了本 bundle 的那个 profile）。
node --input-type=module -e "import('dsh-web-fetch-fakeip/scripts/diagnose.mjs')"
```

也可以直接运行文件——在源码 checkout 里，或经由安装后的路径：

```sh
node scripts/diagnose.mjs
node scripts/diagnose.mjs example.com api.github.com
```

它会打印每个主机名的应答、其 `ipaddr.js` 归类，以及已配置网段是否覆盖，最后给出
结论：

- **fake-ip 且已覆盖** —— 本插件就是正确的解法；若仍失败，问题在目的地判定之后
  （代理路由）。
- **保留地址但未覆盖** —— 把 `fakeIpRanges` 改成上面报告的网段。
- **未见 fake-ip** —— 本机解析出的是真实地址，原版 provider 本就正确，本插件对
  这些主机没有任何改变。

确认组合后的配置树里确实包含替换行：

```sh
dsh --profile web --dump-config | grep -B1 -A4 'fakeip\|web-fetch-http'
```

-----

<a id="工作原理"></a>
## 工作原理

`HttpFetchProvider` 的构造函数接受第二个参数——自定义 resolver，这就是全部的接缝。
本插件传入一个理解 fake-ip 的 resolver，其余一切交给原版类：

```js
import { HttpFetchProvider, LOCAL_FETCH_PROVIDER_ID } from '@deepseek-ai/dsh-web-fetch-http'

const inner = new HttpFetchProvider(limits, createFakeIpResolver(ranges))

ctx.web.registerFetchProvider({
  id: LOCAL_FETCH_PROVIDER_ID,
  available: () => true,
  fetch: (request, signal) => inner.fetch(request, signal),
})
```

resolver 对每组应答的判定：

1. 解析一次（或直接采用字面量）。
2. 拒绝畸形条目（`WEB_PROVIDER_ERROR`）。
3. 若主机名**不是**字面量，且**每个**应答都是落在已配置网段内的占位地址，则原样
   接受该组应答。
4. 否则要求每个应答都是公网 unicast，与原先完全一致。

第 3 步刻意做成全有或全无。占位地址本身不携带目的地，只有本机 TUN 网卡能路由它，
因此接受它并不会打开通往内网服务的通路。而**混合**应答会被拒绝，否则一条 DNS
应答就能靠夹带一个占位地址来放宽策略，把内网地址一并送进来。

### 源码导览

| 文件 | 职责 |
| --- | --- |
| [`src/index.js`](src/index.js) | 插件入口：注册 provider，并再导出 API |
| [`src/config.js`](src/config.js) | 配置 schema、与原版一致的默认值、限制值校验 |
| [`src/resolver.js`](src/resolver.js) | 目的地策略：地址归类、网段匹配、resolver 判定 |
| [`cordis.patch.yml`](cordis.patch.yml) | bundle patch：禁用原版行，插入本行 |
| [`scripts/diagnose.mjs`](scripts/diagnose.mjs) | 报告 DNS 实际应答以及配置是否覆盖 |
| [`scripts/check-package.mjs`](scripts/check-package.mjs) | 当发布包缺少必需文件或夹带禁止文件时失败 |
| [`scripts/release-control.mjs`](scripts/release-control.mjs) | 发布门禁：标签/版本校验、npm 幂等检查、CHANGELOG 说明提取、GitHub Release 同步 |
| [`test/resolver.test.js`](test/resolver.test.js) | 离线单元测试（不联网） |
| [`test/release-control.test.js`](test/release-control.test.js) | 发布门禁的离线测试 |
| [`test/transport.live.js`](test/transport.live.js) | 可选的真实网络测试 |

### 为什么必须禁用原版行

两个 provider 注册的是同一个 fetch-provider id（`http`），而 web 接缝会以
`WEB_DUPLICATE_PROVIDER` 拒绝重复注册。禁用该行并不会移除那个包——本插件正是从
它导入 `HttpFetchProvider`。沿用同一个 id 意味着 `ctx.web.fetch()` 在既有的
`fetchProvider: http` 配置下就会选中本 provider，无需改动 web 服务行。

-----

<a id="开发"></a>
## 开发

需要 Node 22+（在 Node 24 上开发）。

```sh
npm test          # 离线单元测试——不联网、不查 DNS
npm run test:live # 可选的真实网络测试——需要可用的 DNS 与出网
npm run check     # 语法检查 + 离线测试
npm run pack:check # 校验发布包内容
npm run verify    # check + pack:check——发布工作流所依据的门禁
```

离线测试注入 resolver，因此不触碰网络即可断言目的地策略。真实网络测试同时断言
两件事：真实主机名**即使**解析到占位地址也能抓取成功，且每个内网目的地**仍然**被
拒绝。在没有 fake-ip DNS 的主机上，fake-ip 相关断言会自动跳过，因此该套件在任何
环境都有意义。

`pack:check` 的存在理由：`files` 白名单写错在开发期是看不见的——整个工作树都在——
只有消费者安装之后才会暴露。本仓库已经踩过一次，因此该检查在**每次 CI** 都跑，
而不只在发布时跑。

在 profile 之外开发时，`node_modules` 需要能解析到 harness 包。把它指向安装的共享
依赖闭包：

```sh
# Windows（junction，无需管理员权限）
New-Item -ItemType Junction -Path node_modules -Target "$env:USERPROFILE\.dsh\profiles\node_modules"

# POSIX
ln -s "$HOME/.dsh/profiles/node_modules" node_modules
```

`node_modules` 已被 gitignore。

### 持续集成

| 工作流 | 触发 | 用途 |
| --- | --- | --- |
| [`ci.yml`](.github/workflows/ci.yml) | 推送到 `main`、pull request | 覆盖受支持 DSH 版本的测试矩阵、打包校验、真实网络通道 |
| [`release.yml`](.github/workflows/release.yml) | 推送 `v*` 标签 | 经 Trusted Publishing（OIDC）发布到 npm，随后创建 GitHub Release |

测试矩阵**显式钉住**每个 DSH 版本，而不是用范围解析：`@deepseek-ai/dsh-*` 在 npm 上的
`latest` 标签仍指向旧的 `0.0.1-rc` 线，而当前版本挂在 `next` 下。

发布流程与一次性的 npm 配置见 [RELEASING.md](RELEASING.md)。

-----

<a id="安全说明"></a>
## 安全说明

本插件之所以存在，是因为 fake-ip DNS 下原版校验无法被满足；因此值得追问的是这次
放宽的代价是什么。

**放宽范围严格等于占位网段。** fake-ip 下由代理执行真实解析，因此上游可达性取决于
代理自身的路由规则，而非本模块。两个推论：

- **不要让代理规则把内网网段暴露**给模型的抓取工具。若某条规则把 RFC1918 或环回
  流量路由进代理，主机名就可能抵达内网服务——这个风险由代理配置引入，而非本插件，
  但正是本插件让抓取得以成功，因此值得一并审计。
- **IP 字面量永远不是占位地址。** 它指明了调用方选定的目的地，把它交给本机代理
  恰好会抵达校验想要挡住的环回或内网服务。这就是为什么 `http://127.0.0.1/` 仍然被
  拦截，而一个**解析进占位网段的主机名**却不会。

若需要更严格的姿态，把 `fakeIpRanges` 收窄到代理的确切网段（例如
`198.18.0.0/16`），而不是使用较宽的默认值。

-----

<a id="已知限制"></a>
## 已知限制

- **非默认网段必须手工配置。** 插件无法自动探测代理的 `dns.fake-ip-range`；
  `scripts/diagnose.mjs` 会告诉你该填什么。
- **仅解码文本内容** —— 继承自原版 provider。`text/html`、
  `application/xhtml+xml`、`text/*` 以及 JSON/XML 家族会被解码；缺少
  `Content-Type` 或二进制类型会抛 `WEB_UNSUPPORTED_CONTENT_TYPE`。
- **字符集仅取自 `Content-Type` 头**（默认 UTF-8）—— 同样是继承行为；HTML 中的
  `<meta charset>` 声明会被忽略。
- **必须禁用原版 provider。** 两个 provider 不能共用 `http` 这个 id。

## 许可证

[MIT](LICENSE)
