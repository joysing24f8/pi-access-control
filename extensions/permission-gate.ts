/**
 * permission-gate.ts — 路径权限门禁扩展(pi / pi-web 通用)
 *
 * 三条规则(只针对本机路径):
 *   ⓪ adb / ssh / scp / sftp 操作的是其他设备, 设备侧路径不按本机路径判定:
 *      整类只确认一次, 选"始终允许"后本次运行内同工具的后续动作一律放行;
 *   ① 文件删除(任意路径, 含 cwd 内): 弹框确认后才放行;
 *   ② 目标路径解析后不在当前工作目录(cwd)及其子目录内: 弹框确认后才放行。
 *
 * 覆盖范围:
 *   - 结构化工具 read / ls / grep / find / write / edit 的 path 参数(精确判定)
 *   - bash / powershell: 启发式(绝对路径, ~, .., $HOME, $PWD, 引号包裹的路径)
 *     变量拼接、管道、子 shell 里的路径解析不出来 —— 这是"确认门", 不是沙箱;
 *     真正的隔离需要容器/VM。
 *
 * 弹框交互(三选一):
 *   - ✅ 允许这一次           仅本次工具调用放行
 *   - 🔁 始终允许(本次运行)    按"类别 × 目录"写入授权表, 重启即失效
 *   - 🚫 拒绝                拦截, 命令/路径保留在会话中供你自行执行
 *   弹框只显示"目标 + 命令", 并且都做了截断(内容过长会把选项按钮顶出屏幕)。
 *
 * 授权表挂在 globalThis 上: 同一进程内父会话与子代理会话共享一张表
 * (pi 用 jiti 按 cwd 缓存模块实例, 只靠模块级变量在子代理/worktree 场景会各存一份)。
 *
 * 子代理(pi-web):
 *   - 子代理会话默认不加载扩展(内置 profile 硬编码 load_extensions:false), 所以
 *     ~/.pi/agent/agents/ 下的同名 profile 文件必须写 load_extensions: true
 *     (general-purpose / explore / plan; 同名文件是整体覆盖内置 profile, 不是合并)。
 *   - 子代理的弹框会**转发到父会话**显示: 从子代理会话里的 pi-web:subagent 记录拿到
 *     parentSessionId, 再通过 pi-web 进程内的 __piSessions 注册表取父会话 UI
 *     (取不到就退回子代理自己的会话 UI)。父会话 PARENT_PROMPT_TIMEOUT_MS 不回应
 *     按"拒绝"处理 —— 宁可拦错, 不放错。
 *
 * 配置项(文件顶部常量):
 *   - USE_SELECT                     true = 三选一弹框; false = confirm 两选
 *   - CONFIRM_READS                  越界读也要确认(默认 true)
 *   - CONFIRM_DELETES_INSIDE_CWD     cwd 内的删除也确认(默认 true)
 *   - ALLOWED_PATHS                  白名单目录(默认空)
 *   - PARENT_PROMPT_TIMEOUT_MS       转发到父会话的等待上限
 *   - DIALOG_MAX_TARGETS / DIALOG_MAX_CMD_CHARS  弹框内容截断阈值
 *
 * 安装: 作为 pi 包(仓库的 extensions/ 目录被约定发现), 见 README。
 * 不要再往 ~/.pi/agent/extensions/ 放一份同名文件, 否则会重复加载(弹两次框)。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------- 配置 ----------
const USE_SELECT = true;
const CONFIRM_READS = true;
/** cwd 内的删除也要确认(删除是破坏性动作, 默认开着) */
const CONFIRM_DELETES_INSIDE_CWD = true;
const ALLOWED_PATHS: string[] = []; // 白名单, 例: ["/home/joysing/Downloads"]
/** 子代理的确认转发到父会话后的等待上限; 超时按"拒绝"处理 */
const PARENT_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;
/** 弹框里最多列几个目标、命令最多显示多少字(内容过长会把选项按钮顶出屏幕) */
const DIALOG_MAX_TARGETS = 3;
const DIALOG_MAX_CMD_CHARS = 300;

// ---------- 删除命令清单(规则①, 任意路径) ----------
const DELETE_PATTERNS: RegExp[] = [
  // rm / rmdir / unlink / shred / trash / trash-put(可带 sudo, 支持 ; && || 与换行拼接)
  /(?:^\s*|[;&|\n]\s*|&&\s*|\|\|\s*)(?:\bsudo\s+)?\b(?:rm|rmdir|unlink|shred|trash|trash-put)\b/,
  // find ... -delete(注意: -delete 前可能紧跟引号, 不能用 \b 词边界)
  /\bfind\b[^;&|]*-delete\b/,
  // find ... -exec ... rm ...
  /\bfind\b[^;&|]*-exec\b[^;&|]*\brm\b/,
  // xargs rm / xargs rmdir
  /\bxargs\b[^;&|]*\b(?:rm|rmdir)\b/,
  // gio trash(移入回收站)
  /\bgio\s+trash\b/,
  // git clean(删除未跟踪文件)
  /\bgit\s+clean\b/,
];

// ---------- bash 启发式(规则②) ----------
const READ_CMDS =
  /\b(cat|less|more|head|tail|grep|rg|sed|awk|vi|vim|nano|file|stat|du|df|wc|diff|md5sum|sha256sum|strings|xxd|od|find|ls|tree|source|type)\b/;
const WRITE_CMDS =
  /\b(cp|mv|tee|touch|chmod|chown|install|ln|mkdir|mkfifo|curl|wget|scp|rsync|dd)\b/;
const REDIRECT = /(?:^|[\s;&|])(>{1,2})/;
/** $() 或反引号: 路径在运行时由子命令生成, 静态解析不出来 → 兜底确认 */
const OPAQUE_SUBST = /\$\(|`/;

// ---------- 授权表(进程级, 重启失效) ----------
type Category = "read" | "write" | "delete" | "device" | "other";

const CATEGORY_LABEL: Record<Category, string> = {
  read: "越界读取",
  write: "越界写入",
  delete: "删除",
  device: "其他设备操作",
  other: "越界操作",
};

/** 授权表挂在 globalThis: 同进程内父会话 / 子代理会话共用一张表 */
const GRANT_SLOT = "__permissionGateGrants";
const globalSlots = globalThis as unknown as Record<string, Map<Category, Set<string>> | undefined>;
const ALLOWED: Map<Category, Set<string>> = (globalSlots[GRANT_SLOT] ??= new Map());

// ---------- 路径工具 ----------
const SEP = path.sep;
const HOME = os.homedir();

/**
 * 解析到"最近存在祖先的 realpath"再拼回剩余部分。
 * 直接 realpathSync 对不存在的路径(新建文件)会抛错, 退回词法路径后与 cwd 的 realpath
 * 比较会不一致 —— cwd 路径里含软链时会误报越界。
 */
function realOrResolve(p: string): string {
  const abs = path.resolve(p);
  let cur = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return rest.length === 0 ? real : path.join(real, ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs; // 到根仍失败(权限等): 退回词法路径
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/** 展开 $HOME / ${HOME} / $PWD / ${PWD} */
function expandEnv(s: string, cwd: string): string {
  return s.replace(/\$\{?HOME\}?/g, HOME).replace(/\$\{?PWD\}?/g, cwd);
}

function resolvePath(p: string, cwd: string): string {
  let s = expandEnv(p.trim(), cwd);
  if (s === "~") s = HOME;
  else if (s.startsWith("~/")) s = path.join(HOME, s.slice(2));
  return path.resolve(cwd, s);
}

/** 统一比较(含软链解析): child 是否在 parent 内 */
function isInside(parent: string, child: string): boolean {
  const p = realOrResolve(path.resolve(parent));
  const c = realOrResolve(path.resolve(child));
  return c === p || c.startsWith(p + SEP);
}

/** 授权键: 目录→自身, 文件/不存在→父目录 */
function grantKey(p: string): string {
  const abs = realOrResolve(path.resolve(p));
  try {
    if (fs.statSync(abs).isDirectory()) return abs;
  } catch {
    /* 不存在或不可访问 */
  }
  return path.dirname(abs);
}

/** 授权键匹配: 相等, 或 key 在 allowed 目录之下(路径键以 "/" 分隔; device:xxx 这种工具键只相等匹配) */
function isKeyAllowed(category: Category, key: string): boolean {
  const set = ALLOWED.get(category);
  if (!set) return false;
  for (const allowed of set) {
    if (key === allowed || key.startsWith(allowed + SEP)) return true;
  }
  return false;
}

function grantKeyValue(category: Category, key: string): void {
  let set = ALLOWED.get(category);
  if (!set) {
    set = new Set();
    ALLOWED.set(category, set);
  }
  set.add(key);
}

/** 路径目标的便捷封装(目录粒度) */
function isAllowed(category: Category, target: string): boolean {
  return isKeyAllowed(category, grantKey(target));
}

function grant(category: Category, target: string): void {
  grantKeyValue(category, grantKey(target));
}

// ---------- 弹框排队 ----------
/**
 * pi-web 客户端每条会话只有一个弹框槽位, 第二个请求会把第一个顶掉(第一个就永远等不到答案)。
 * 所以按"目标会话"排队串行弹框, 并在拿到锁后重新检查授权 —— 主会话或别的子代理刚授权过的
 * 目录, 这里的子代理直接放行, 不再重复弹框。
 */
const QUEUE_SLOT = "__permissionGateQueues";
const promptQueues = ((globalThis as unknown as Record<string, unknown>)[QUEUE_SLOT] ??= new Map<
  string,
  Promise<unknown>
>()) as Map<string, Promise<unknown>>;

function withQueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = promptQueues.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  promptQueues.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

// ---------- bash 命令分析 ----------
/** 从命令中提取路径 token(引号包裹的含 / 字符串, 或裸的绝对/~/../$HOME/$PWD 路径) */
function extractPathTokens(command: string): string[] {
  const tokens = new Set<string>();
  for (const m of command.matchAll(/["']([^"']*\/[^"']*)["']/g)) {
    tokens.add(m[1]);
  }
  // 裸 token: 绝对路径 / ~ 开头 / .. 开头 / $HOME、$PWD 展开式
  // 边界含 "=": `VAR=$HOME/x` 这种赋值也要能提取出来, 否则 `X=$HOME/secret; cat $X` 会绕过门禁
  const bare =
    /(?:^|[\s;&|(=])(\$\{?(?:HOME|PWD)\}?[^\s;&|()>]*|~[^\s;&|()>]*|\/[^\s;&|()>]*|\.\.[^\s;&|()>]*)/g;
  for (const m of command.matchAll(bare)) {
    tokens.add(m[1]);
  }
  const clean: string[] = [];
  for (const t of tokens) {
    clean.push(t.replace(/[,)\]'"]+$/, ""));
  }
  return clean;
}

/** 命令里 cd 的目标(用来区分"真的 cd 出去了"和"只是命令里出现了越界路径") */
function cdTargets(command: string, cwd: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/(?:^|[\s;&|])cd\s+([^\s;&|]+)/g)) {
    out.push(resolvePath(m[1].replace(/^["']|["']$/g, ""), cwd));
  }
  return out;
}

/** 重定向(> / >>)的目标(用来区分"越界写入是不是真由重定向引起") */
function redirectTargets(command: string, cwd: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/>{1,2}\s*([^\s;&|]+)/g)) {
    out.push(resolvePath(m[1].replace(/^["']|["']$/g, ""), cwd));
  }
  return out;
}

// ---------- 其他设备(adb / ssh 等) ----------
/** 这些工具操作的是别的设备, 设备侧路径不按本机路径判定 */
const DEVICE_TOOLS = new Set(["adb", "ssh", "scp", "sftp"]);

/**
 * 命令是不是在操作其他设备。认两种写法:
 *   1. 命令里出现 `adb`/`ssh`/`scp`/`sftp` 这个词(前后是空白/分隔符, 所以 sshd、.ssh、ssh-keygen 不算);
 *   2. 路径 token 的 basename 就是它 —— 覆盖 `ADB=$HOME/tools/platform-tools/adb; "$ADB" ...` 这种变量包装写法。
 */
function deviceTool(command: string): string | undefined {
  const word = command.match(/(?:^|[\s;&|(])(adb|ssh|scp|sftp)(?=\s|$)/);
  if (word) return word[1];
  for (const t of extractPathTokens(command)) {
    if (DEVICE_TOOLS.has(path.basename(t.replace(/["']+$/, "")))) {
      return path.basename(t.replace(/["']+$/, ""));
    }
  }
  return undefined;
}

interface BashFinding {
  category: Category;
  targets: string[]; // 展示用: resolve 后的绝对路径
  keys?: string[]; // 授权键; 缺省 = targets 各自的 grantKey(目录粒度)
  summary: string;
}

/**
 * 唯一规则: 目标解析后不在 cwd 内 → 需要确认。
 * targets 为空数组表示"路径无法静态解析"(如 $()/反引号), 此时兜底确认。
 */
function analyzeBash(command: string, cwd: string): BashFinding | null {
  // 规则⓪: 操作其他设备(adb/ssh/scp/sftp)。设备侧路径不是本机路径, 不按 cwd 判定;
  // 整类只确认一次 —— 选"始终允许"后, 本次运行内同工具的后续动作一律放行。
  const tool = deviceTool(command);
  if (tool) {
    return {
      category: "device",
      targets: [],
      keys: [`device:${tool}`],
      summary: `${tool} 操作其他设备(设备侧路径不按本机路径判定)`,
    };
  }

  const isDelete = DELETE_PATTERNS.some((p) => p.test(command));
  const all = extractPathTokens(command).map((t) => resolvePath(t, cwd));
  const targets = all.filter((p) => !isInside(cwd, p));

  // 旧行为(默认关闭): 任意路径的删除都确认, 包括 cwd 内
  if (isDelete && CONFIRM_DELETES_INSIDE_CWD) {
    return { category: "delete", targets: all, summary: "检测到文件删除命令" };
  }

  if (targets.length === 0) {
    // 路径都在 cwd 内: 只有"路径由子命令动态生成"的写/删才兜底确认
    if (OPAQUE_SUBST.test(command) && (isDelete || REDIRECT.test(command) || WRITE_CMDS.test(command))) {
      return {
        category: isDelete ? "delete" : "write",
        targets: [],
        summary: "命令含 $()/反引号, 目标路径无法静态解析",
      };
    }
    return null;
  }

  if (isDelete) {
    return { category: "delete", targets, summary: "删除工作目录之外的文件" };
  }
  // 只看 cd / 重定向的**目标**是否越界, 不看命令里有没有 cd 或 > 。
  // 否则 `cd <cwd 自身> && $HOME/tools/adb ...` 会被误报成"cd 到工作目录之外"。
  if (cdTargets(command, cwd).some((p) => !isInside(cwd, p))) {
    return { category: "other", targets, summary: "cd 到工作目录之外" };
  }
  if (redirectTargets(command, cwd).some((p) => !isInside(cwd, p))) {
    return { category: "write", targets, summary: "重定向写入工作目录之外" };
  }
  if (WRITE_CMDS.test(command)) {
    return { category: "write", targets, summary: "写操作涉及工作目录之外" };
  }
  if (READ_CMDS.test(command)) {
    return { category: "read", targets, summary: "读操作涉及工作目录之外" };
  }
  return { category: "other", targets, summary: "命令涉及工作目录之外" };
}

// ---------- 确认流程 ----------
type UiRoute = { ui: ExtensionContext["ui"]; source?: string; routed: boolean; key: string };

interface SubagentMeta {
  parentSessionId?: string;
  profile?: string;
  description?: string;
}

/** 当前会话是不是 pi-web 子代理会话(pi-web 会往子代理会话里写一条 pi-web:subagent 记录) */
function subagentMeta(ctx: ExtensionContext): SubagentMeta | undefined {
  try {
    const entries = ctx.sessionManager.getEntries() as Array<{
      type?: string;
      customType?: string;
      data?: unknown;
    }>;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type === "custom" && e.customType === "pi-web:subagent") {
        return e.data as SubagentMeta;
      }
    }
  } catch {
    /* 非 pi-web 或接口变化: 当作普通会话 */
  }
  return undefined;
}

/**
 * 子代理会话 → 父会话的 UI。
 * 子代理自己的弹框挂在子代理的会话流上, 父会话看不到, 所以转发到父会话。
 * pi-web 的进程内会话注册表是内部 API, 取不到就返回 undefined(退回本会话 UI)。
 */
function parentUi(
  ctx: ExtensionContext,
): { ui: ExtensionContext["ui"]; source: string; sessionId: string } | undefined {
  if (ctx.mode !== "rpc") return undefined;
  const meta = subagentMeta(ctx);
  if (!meta?.parentSessionId) return undefined;

  const sessions = (globalThis as { __piSessions?: Map<string, unknown> }).__piSessions;
  const wrapper = sessions?.get(meta.parentSessionId) as
    | {
        inner?: {
          extensionRunner?: {
            hasUI?: () => boolean;
            getUIContext?: () => ExtensionContext["ui"];
          };
        };
      }
    | undefined;
  const runner = wrapper?.inner?.extensionRunner;
  if (!runner?.hasUI?.()) return undefined;
  const ui = runner.getUIContext?.();
  if (!ui) return undefined;
  return { ui, source: meta.profile ? `子代理:${meta.profile}` : "子代理", sessionId: meta.parentSessionId };
}

/** 这次确认弹到哪个会话; undefined = 没有可用界面 → 一律拦截。key = 排队键(目标会话) */
function approvalTarget(ctx: ExtensionContext): UiRoute | undefined {
  const parent = parentUi(ctx);
  if (parent) {
    return { ui: parent.ui, source: parent.source, routed: true, key: `parent:${parent.sessionId}` };
  }
  if (!ctx.hasUI) return undefined;
  return { ui: ctx.ui, routed: false, key: `self:${ctx.sessionManager.getSessionId()}` };
}

/** 弹框内容截断: 内容太长会把选项按钮顶出屏幕 */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…(共 ${text.length} 字)`;
}

function targetsText(targets: string[]): string {
  if (targets.length === 0) return "    (路径无法静态解析)";
  const head = targets
    .slice(0, DIALOG_MAX_TARGETS)
    .map((t) => `    ${t}`)
    .join("\n");
  return targets.length > DIALOG_MAX_TARGETS ? `${head}\n    …共 ${targets.length} 个目标` : head;
}

async function requestApproval(
  ctx: ExtensionContext,
  category: Category,
  targets: string[],
  summary: string,
  commandText: string,
  keys?: string[],
): Promise<{ block: true; reason: string } | undefined> {
  const cwd = ctx.cwd;
  const grantKeys = keys ?? targets.map((t) => grantKey(t));

  // 预留白名单(默认空数组, 不生效)
  if (ALLOWED_PATHS.length > 0 && targets.length > 0) {
    const allowedReal = ALLOWED_PATHS.map((a) => realOrResolve(resolvePath(a, cwd)));
    if (targets.every((t) => allowedReal.some((a) => isInside(a, t)))) {
      return undefined;
    }
  }

  // 读操作开关
  if (category === "read" && !CONFIRM_READS) return undefined;

  // 已授权: 同类同键不再询问(路径键 = 目录粒度; 设备键 = 工具级)
  if (grantKeys.length > 0 && grantKeys.every((k) => isKeyAllowed(category, k))) return undefined;

  const route = approvalTarget(ctx);
  if (!route) {
    return {
      block: true,
      reason: `已拦截(${CATEGORY_LABEL[category]}, 无交互界面默认拒绝):\n${commandText}`,
    };
  }

  return withQueue(route.key, async () => {
    // 排队等待期间, 主会话或别的子代理可能已经授权过同样的键 → 直接放行, 不再弹框
    if (grantKeys.length > 0 && grantKeys.every((k) => isKeyAllowed(category, k))) return undefined;

    const deny = {
      block: true as const,
      reason: `已拦截(${CATEGORY_LABEL[category]}, cwd=${cwd}):\n${commandText}\n\n如需执行, 请自行运行上面的命令。`,
    };

    // 弹框只给"目标 + 命令", 且都截断过
    const title = `⚠️ ${category === "delete" ? "删除" : category === "device" ? "设备操作" : "越界"}确认${route.source ? `(${route.source})` : ""}`;
    const body =
      `${summary}\n` +
      (targets.length > 0 ? `  目标:\n${targetsText(targets)}\n\n` : "") +
      `命令:\n${clip(commandText, DIALOG_MAX_CMD_CHARS)}`;

    const opts: { signal?: AbortSignal; timeout?: number } = { signal: ctx.signal };
    if (route.routed) opts.timeout = PARENT_PROMPT_TIMEOUT_MS;

    try {
      if (USE_SELECT) {
        const options =
          grantKeys.length > 0
            ? ["✅ 允许这一次", "🔁 始终允许(本次 pi 运行)", "🚫 拒绝"]
            : ["✅ 允许这一次", "🚫 拒绝"];
        const choice = await route.ui.select(`${title}\n\n${body}`, options, opts);
        if (choice === "✅ 允许这一次") return undefined;
        if (choice === "🔁 始终允许(本次 pi 运行)") {
          for (const k of grantKeys) grantKeyValue(category, k);
          return undefined;
        }
        return deny;
      }

      const ok = await route.ui.confirm(
        title,
        `${body}\n\n是否允许? 选"否"则拦截, 命令保留在会话中供你自行执行。`,
        opts,
      );
      return ok ? undefined : deny;
    } catch {
      // 父会话 UI 已失效 / 会话被中止: 兜底拦截
      return deny;
    }
  });
}

// ---------- 结构化工具 → 类别 ----------
const TOOL_CATEGORY: Record<string, Category> = {
  read: "read",
  ls: "read",
  grep: "read",
  find: "read",
  write: "write",
  edit: "write",
};

// ---------- 扩展入口 ----------
export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const cwd = ctx.cwd;

    // bash / powershell: 越界启发式(解析不出来的一律按启发式兜底)
    const shellCommand: string | undefined = isToolCallEventType("bash", event)
      ? event.input.command
      : event.toolName === "powershell" &&
          typeof (event.input as { command?: unknown }).command === "string"
        ? (event.input as { command: string }).command
        : undefined;

    if (shellCommand !== undefined) {
      const finding = analyzeBash(shellCommand, cwd);
      if (!finding) return undefined;
      return requestApproval(
        ctx,
        finding.category,
        finding.targets,
        finding.summary,
        shellCommand,
        finding.keys,
      );
    }

    // 结构化工具: 检查 path 参数是否越界
    const category = TOOL_CATEGORY[event.toolName];
    if (!category) return undefined;

    const rawPath = (event.input as { path?: unknown }).path;
    if (typeof rawPath !== "string" || rawPath.trim() === "") return undefined;

    const resolved = resolvePath(rawPath, cwd);
    if (isInside(cwd, resolved)) return undefined;

    return requestApproval(
      ctx,
      category,
      [resolved],
      `工具 ${event.toolName} 操作目标不在工作目录内`,
      `${event.toolName} ${rawPath}`,
    );
  });
}

// ---------- 调试导出(供命令行自测) ----------
export {
  analyzeBash,
  extractPathTokens,
  isInside,
  resolvePath,
  grant,
  isAllowed,
  grantKeyValue,
  isKeyAllowed,
};
