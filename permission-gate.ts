/**
 * permission-gate.ts — 路径权限门禁扩展(pi / pi-web 通用)
 *
 * 需求:
 *   ① 文件删除动作(任意路径): 弹框确认后才允许执行;
 *   ② 操作当前工作目录(cwd)之外的文件/目录(含读操作): 弹框确认后才允许继续;
 *   ③ 拒绝时把命令/路径展示出来, 供用户自行执行。
 *
 * 弹框交互(三选一):
 *   - ✅ 允许这一次           仅本次工具调用放行
 *   - 🔁 始终允许(本次运行)    写入进程内授权表, 本次 pi 进程内同类操作不再询问;
 *                            授权只存内存, 重启 pi / pi-web 即失效(下次启动重新授权)
 *   - 🚫 拒绝                拦截, 命令/路径保留在会话中供用户自行执行
 *
 * 授权粒度: 类别(read / write / delete / other) × 路径目录
 *   - 读 /etc/passwd 并选择"始终允许" = 允许读取 /etc/ 目录(不再逐个询问 /etc 下文件)
 *   - "始终允许读 /etc" 不会连带放行 写/删除 /etc 下的文件
 *
 * 判定:
 *   - 结构化工具(read/write/edit/grep/find/ls): 检查 path 参数,
 *     resolve 后不在 cwd 内 → 确认; 软链指向 cwd 外同样确认(严格模式)
 *   - bash: 启发式检测(cd 外部目录 / 绝对路径参数 / ~ 展开 / 重定向 / 删除命令),
 *     无法 100% 覆盖(变量、管道、子 shell 解析不了)
 *     —— 这是"确认门", 不是沙箱; 真正的隔离需要容器/VM
 *
 * 配置项(文件顶部常量):
 *   - USE_SELECT      true = 三选一弹框(默认); false = confirm 两选(允许/拒绝)
 *   - CONFIRM_READS   读操作也要确认(默认 true; 设为 false 只拦写/删)
 *   - ALLOWED_PATHS   白名单(预留, 默认空数组) 例: ["/home/joysing/Downloads"]
 *
 * 安装: 放到 ~/.pi/agent/extensions/permission-gate.ts, 重启 pi/pi-web 生效。
 * 只改动扩展目录, 不修改 pi / pi-web 任何原生文件, 升级无兼容风险。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------- 配置 ----------
const USE_SELECT = true;
const CONFIRM_READS = true;
const ALLOWED_PATHS: string[] = []; // 预留白名单, 例: ["/home/joysing/Downloads"]

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

// ---------- 授权表(进程级, 重启失效) ----------
type Category = "read" | "write" | "delete" | "other";

const CATEGORY_LABEL: Record<Category, string> = {
  read: "越界读取",
  write: "越界写入",
  delete: "文件删除",
  other: "越界操作",
};

const ALLOWED = new Map<Category, Set<string>>();

// ---------- 路径工具 ----------
const SEP = path.sep;

function realOrResolve(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function resolvePath(p: string, cwd: string): string {
  let s = p.trim();
  if (s === "~") s = os.homedir();
  else if (s.startsWith("~/")) s = path.join(os.homedir(), s.slice(2));
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

function isAllowed(category: Category, target: string): boolean {
  const set = ALLOWED.get(category);
  if (!set) return false;
  const key = grantKey(target);
  for (const allowed of set) {
    if (key === allowed || key.startsWith(allowed + SEP)) return true;
  }
  return false;
}

function grant(category: Category, target: string): void {
  const key = grantKey(target);
  let set = ALLOWED.get(category);
  if (!set) {
    set = new Set();
    ALLOWED.set(category, set);
  }
  set.add(key);
}

// ---------- bash 命令分析 ----------
/** 从命令中提取路径 token(引号包裹 或 裸的绝对/~/../路径) */
function extractPathTokens(command: string): string[] {
  const tokens = new Set<string>();
  for (const m of command.matchAll(/["']([^"']*\/[^"']*)["']/g)) {
    tokens.add(m[1]);
  }
  for (const m of command.matchAll(/(?:^|[\s;&|(])([~/][^\s;&|()>]*|\.\.[^\s;&|()>]*)/g)) {
    tokens.add(m[1]);
  }
  const clean: string[] = [];
  for (const t of tokens) {
    clean.push(t.replace(/[,)\]'"]+$/, ""));
  }
  return clean;
}

interface BashFinding {
  category: Category;
  targets: string[]; // resolve 后的绝对路径(越界部分)
  summary: string;
}

function analyzeBash(command: string, cwd: string): BashFinding | null {
  // 规则①: 删除(任意路径, 即使目标在 cwd 内)
  if (DELETE_PATTERNS.some((p) => p.test(command))) {
    const targets = extractPathTokens(command)
      .map((t) => resolvePath(t, cwd))
      .filter((p) => !isInside(cwd, p));
    return { category: "delete", targets, summary: "检测到文件删除命令" };
  }

  // 规则②: 越界(含读)
  const targets = extractPathTokens(command)
    .map((t) => resolvePath(t, cwd))
    .filter((p) => !isInside(cwd, p));
  if (targets.length === 0) return null;

  if (/\bcd\b/.test(command)) {
    return { category: "other", targets, summary: "cd 到工作目录之外" };
  }
  if (REDIRECT.test(command)) {
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
async function requestApproval(
  ctx: ExtensionContext,
  category: Category,
  targets: string[],
  summary: string,
  commandText: string,
): Promise<{ block: true; reason: string } | undefined> {
  const cwd = ctx.cwd;

  // 预留白名单(默认空数组, 不生效)
  if (ALLOWED_PATHS.length > 0 && targets.length > 0) {
    const allowedReal = ALLOWED_PATHS.map((a) => realOrResolve(resolvePath(a, cwd)));
    if (targets.every((t) => allowedReal.some((a) => isInside(a, t)))) {
      return undefined;
    }
  }

  // 读操作开关
  if (category === "read" && !CONFIRM_READS) return undefined;

  // 已授权: 同类同路径(目录粒度)不再询问
  if (targets.length > 0 && targets.every((t) => isAllowed(category, t))) return undefined;

  if (!ctx.hasUI) {
    return {
      block: true,
      reason: `已拦截(${CATEGORY_LABEL[category]}, 无交互界面默认拒绝):\n${commandText}`,
    };
  }

  const targetText = targets.length > 0 ? targets.join("\n    ") : "(任意路径)";
  const message =
    `${summary}\n` +
    `  类别: ${CATEGORY_LABEL[category]}\n` +
    `  目标:\n    ${targetText}\n` +
    `  工作目录(cwd):\n    ${cwd}\n\n` +
    `命令:\n${commandText}`;

  if (USE_SELECT) {
    const hasGrantTarget = targets.length > 0;
    const options = hasGrantTarget
      ? ["✅ 允许这一次", "🔁 始终允许(本次 pi 运行)", "🚫 拒绝"]
      : ["✅ 允许这一次", "🚫 拒绝"];
    const choice = await ctx.ui.select(
      `⚠️ ${category === "delete" ? "删除" : "越界"}操作确认\n\n${message}`,
      options,
    );

    if (choice === "✅ 允许这一次") return undefined;
    if (choice === "🔁 始终允许(本次 pi 运行)") {
      for (const t of targets) grant(category, t);
      return undefined;
    }
    return {
      block: true,
      reason: `已拦截(${CATEGORY_LABEL[category]}):\n${commandText}\n\n如需执行, 请自行运行上面的命令。`,
    };
  }

  // confirm 模式(USE_SELECT=false)
  const ok = await ctx.ui.confirm(
    `⚠️ ${category === "delete" ? "删除" : "越界"}操作确认`,
    `${message}\n\n是否允许? 选"否"则拦截, 命令保留在会话中供你自行执行。`,
  );
  if (!ok) {
    return {
      block: true,
      reason: `已拦截(${CATEGORY_LABEL[category]}):\n${commandText}\n\n如需执行, 请自行运行上面的命令。`,
    };
  }
  return undefined;
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

    // bash: 删除规则 + 越界启发式
    if (isToolCallEventType("bash", event)) {
      const finding = analyzeBash(event.input.command, cwd);
      if (!finding) return undefined;
      return requestApproval(ctx, finding.category, finding.targets, finding.summary, event.input.command);
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
export { analyzeBash, extractPathTokens, isInside, resolvePath };
