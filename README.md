# local-permission-manager — 路径权限门禁扩展

给 pi / pi-web 增加"操作前确认"门禁：**文件删除**、以及**操作当前工作目录(cwd)之外的文件(含读)**，都必须弹框确认才能继续；拒绝时把命令/路径展示给你，供你自行执行。

只通过官方扩展机制实现（`~/.pi/agent/extensions/`），**不修改 pi / pi-web 的任何原生文件**，升级无兼容风险。

## 文件

```
local-permission-manager/
├── permission-gate.ts   # 扩展源码(唯一逻辑文件)
└── README.md
```

安装时把 `permission-gate.ts` 放进 `~/.pi/agent/extensions/`（推荐用软链，改源码即时生效）：

```bash
ln -s ~/workspace/pi-tools/local-permission-manager/permission-gate.ts ~/.pi/agent/extensions/permission-gate.ts
```

然后**重启 pi-web / pi**（新会话会自动加载，保险起见重启服务）。

## 两条规则

| 规则 | 触发 | 说明 |
|---|---|---|
| ① 文件删除 | `bash` | `rm` / `rmdir` / `unlink` / `shred` / `trash` / `find -delete` / `xargs rm` / `git clean` / `gio trash`，**任意路径**都要确认 |
| ② 越界操作(含读) | `read`/`write`/`edit`/`grep`/`find`/`ls` 的 `path` 参数 + `bash` 启发式 | 目标 resolve 后在 cwd 之外 → 确认；软链指向 cwd 外同样确认(严格模式) |

bash 启发式检测：`cd` 到外部目录、绝对路径参数、`~/` 展开、`>`/`>>` 重定向到外部、`cp/mv/cat` 等操作外部路径。

## 弹框交互

三选一（`USE_SELECT=true`）：

- **✅ 允许这一次** —— 仅本次调用放行
- **🔁 始终允许(本次 pi 运行)** —— 写入**进程内授权表**，本次 pi 进程内同类操作不再询问；**重启 pi/pi-web 即失效**（授权不落盘，下次启动重新授权）
- **🚫 拒绝** —— 拦截，命令/路径保留在会话里供你自行执行

授权粒度 = **类别 × 路径目录**：

- 读 `/etc/passwd` 并"始终允许" = 允许读 `/etc/` 下所有文件
- "始终允许读 `/etc`" **不会**连带放行写/删除 `/etc`

无 UI 模式（`-p` 等）→ 一律拦截。

## 配置项（`permission-gate.ts` 顶部常量）

| 常量 | 默认 | 说明 |
|---|---|---|
| `USE_SELECT` | `true` | `false` 时改为 confirm 两选(允许/拒绝)，更保守 |
| `CONFIRM_READS` | `true` | `false` 时读操作不再确认，只拦写/删 |
| `ALLOWED_PATHS` | `[]` | 预留白名单，例 `["/home/joysing/Downloads"]`，填了就放行其中操作 |

## 验证

1. 让 pi 执行 `rm` / `rmdir` / `find . -delete` → 应弹删除确认；
2. 让 pi 执行 `cat /etc/hosts` 或 `read /etc/hosts` → 应弹越界确认；
3. 选"始终允许"后同类操作不再询问；重启 pi-web 后重新询问；
4. 拒绝时命令留在会话里，你复制到终端执行。

## 已知限制（重要）

- **这是"确认门"，不是沙箱**。bash 启发式解析不了变量、管道、子 shell、`python -c` 等写法，模型可以用这些方式绕过启发式。要物理隔离，需用容器/VM（见 pi 官方 `containerization.md`，有 Gondolin 方案）。
- bash 启发式会误报（如 `export FOO=/tmp/x`、`ls /`），确认成本低，宁可多拦。
- 结构化工具精确；bash 只能尽力而为。

## 升级兼容

- 仅新增 `~/.pi/agent/extensions/permission-gate.ts`，pi / pi-web 安装文件零改动；
- 全部使用官方扩展 API（`tool_call` 事件 + `block` + `ctx.ui`）；
- 升级 pi/pi-web 时若 API 有变化，只需微调本扩展，不影响原生行为。
