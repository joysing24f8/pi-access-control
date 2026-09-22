# pi-access-control — 路径权限门禁扩展

给 pi / pi-web 加一道"操作前确认"的门禁：**任何文件删除**、以及**任何指向当前工作目录(cwd)之外的操作(含读)**，都要弹框确认后才放行。只用 pi 官方扩展机制实现，不修改 pi / pi-web 任何原生文件。

## 两条规则

| 规则 | 触发 | 说明 |
|---|---|---|
| ⓪ 其他设备操作 | `bash` 里出现 `adb`/`ssh`/`scp`/`sftp`(含 `ADB=$HOME/.../adb` 这类变量包装) | 设备侧路径**不按**本机路径判定；整类只确认一次，选"始终允许"后本次运行内同工具的动作一律放行 |
| ① 文件删除 | `bash` 启发式 | `rm` / `rmdir` / `unlink` / `shred` / `trash` / `gio trash` / `find -delete` / `find -exec rm` / `xargs rm` / `git clean`，**任意路径**(含 cwd 内)都要确认 |
| ② 越界操作(含读) | `read`/`ls`/`grep`/`find`/`write`/`edit` 的 `path` 参数 + `bash`/`powershell` 启发式 | 目标 resolve 后不在 cwd 及其子目录内 → 确认 |

想让 cwd 内的删除不再确认：把 `CONFIRM_DELETES_INSIDE_CWD` 改成 `false`。

## 安装

### 1. 作为 pi 包安装(推荐)

`~/.pi/agent/settings.json`：

```json
{
  "packages": [
    "git:https://github.com/joysing24f8/pi-access-control"
  ]
}
```

也可以在 pi-web 的 Plugins 面板 Add plugin 里填 `git:https://github.com/joysing24f8/pi-access-control`（scope 选 global）。pi 会 clone 到 `~/.pi/agent/git/github.com/joysing24f8/pi-access-control`，并自动发现仓库里的 `extensions/` 目录（没有 `pi` manifest 时走约定目录）。

**不要再往 `~/.pi/agent/extensions/` 放一份同名文件**，那样会重复加载（同一个操作弹两次框）。

### 2. 子代理 profile(必须，否则子代理绕过门禁)

pi-web 内置的子代理 profile 硬编码 `loadExtensions: false`，子代理会话根本不加载任何扩展。把本仓库 `agents/` 下三个文件复制到 `~/.pi/agent/agents/`：

```bash
mkdir -p ~/.pi/agent/agents
cp agents/*.md ~/.pi/agent/agents/
```

它们的 frontmatter 里有 `load_extensions: true`；因为**同名 profile 文件是整体覆盖内置 profile(不是合并)**，文件里同时复制了内置的 `tools` 和 systemPrompt。pi-web 升级若改了内置 profile 的 prompt/tools，需要同步这三个文件。

装完**重启 pi-web / pi**。

## 交互

弹框三选一：

- **✅ 允许这一次** —— 仅本次调用放行
- **🔁 始终允许(本次 pi 运行)** —— 写入进程内授权表(类别 × 目录)，重启即失效
- **🚫 拒绝** —— 拦截，命令保留在会话里供你自行执行

授权粒度 = 类别(read / write / delete / device / other) × 键：路径类键是**目录**(读 `/etc/passwd` 选"始终允许" = 放行读 `/etc/` 下所有文件，但不会连带放行写/删 `/etc`)；`device` 类的键是**工具**(`device:adb` / `device:ssh`)，互不串。

弹框内容只显示**目标 + 命令**，并且都截断过(长内容会把选项按钮顶出屏幕)：最多 `DIALOG_MAX_TARGETS` 个目标、命令最多 `DIALOG_MAX_CMD_CHARS` 字。完整命令在"拒绝"的理由里。

### 子代理

子代理触发门禁时，弹框会**转发到父会话**显示，不需要切到子代理页面。做法是从子代理会话里的 `pi-web:subagent` 记录取 `parentSessionId`，再通过 pi-web 进程内的 `__piSessions` 注册表拿父会话 UI；取不到就退回子代理自己的会话 UI。父会话 `PARENT_PROMPT_TIMEOUT_MS`(默认 10 分钟)不回应 → 按拒绝处理。无交互界面(`-p`)一律拦截。

## 配置(扩展源码顶部常量)

| 常量 | 默认 | 说明 |
|---|---|---|
| `USE_SELECT` | `true` | `false` = confirm 两选(允许/拒绝) |
| `CONFIRM_READS` | `true` | `false` = 越界读不确认，只拦写/删 |
| `CONFIRM_DELETES_INSIDE_CWD` | `true` | `false` = cwd 内的删除不确认 |
| `ALLOWED_PATHS` | `[]` | 白名单目录，例 `["/home/joysing/Downloads"]` |
| `PARENT_PROMPT_TIMEOUT_MS` | `600000` | 转发到父会话的等待上限 |
| `DIALOG_MAX_TARGETS` | `3` | 弹框最多列几个目标 |
| `DIALOG_MAX_CMD_CHARS` | `300` | 弹框里命令最多显示多少字 |

## 验证

```bash
node test-logic.mjs   # 纯逻辑断言(analyzeBash / isInside)，不需要 pi 运行时
```

手工验证：`cat /etc/hosts`、`rm -rf <cwd 内目录>` 应弹框；让子代理读 `/etc/hostname`，弹框应出现在**父会话**里。

## 已知限制(重要)

- **这是"确认门"，不是沙箱**：bash 启发式解析不了变量拼接、管道、子 shell、`python -c` 等写法，模型可以用这些绕过。要物理隔离请用容器/VM(见 pi 官方 `containerization.md`)。
- 启发式会误报(如 Windows 风格斜杠开关 `/f`、`export FOO=/tmp/x`)，宁可多拦。
- 子代理转发依赖 pi-web 内部的 `__piSessions` 全局；pi-web 大版本升级若改名，会静默退回子代理自己的会话(门禁仍生效，只是位置变回子代理页)。
- `adb`/`ssh` 判定是启发式的：命令里只要出现这些工具就整类按"设备操作"处理，所以 `which adb` 之类也会算；反过来，一个命令里若同时混了 adb/ssh 和本机的破坏性操作(如 `adb push x /data && rm -rf build`)，会跟着设备授权一起放行。要更强的区分只能改成解析 AST。

## 维护

```
pi-access-control/
├── extensions/permission-gate.ts   # 扩展源码(唯一逻辑文件)
├── agents/*.md                     # pi-web 子代理 profile(复制到 ~/.pi/agent/agents/)
├── test-logic.mjs                  # 纯逻辑自测
└── package.json                    # pi 包元数据(靠 extensions/ 约定目录被发现)
```

改完跑 `node test-logic.mjs`，提交推到 main，然后在 pi-web 的 Plugins 面板点 Update(或 `pi update --extensions`)拉取，重启生效。pi 只在安装/更新时同步 git 包，启动时不会自动 pull。

## 升级兼容

- 只用官方扩展 API(`tool_call` 事件 + `block` + `ctx.ui`)，不改 pi / pi-web 原生文件；
- 子代理转发用 pi-web 内部注册表，全部 optional chaining 兜底；
- pi / pi-web 升级后若 API 变化，只需改本扩展。
