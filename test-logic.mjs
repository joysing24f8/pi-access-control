#!/usr/bin/env node
/**
 * 纯逻辑自测: node test-logic.mjs
 *
 * 扩展源码 import 了 @earendil-works/pi-coding-agent(只有 pi 运行时会注入), 直接 import
 * .ts 会解析失败。所以这里去掉那一行 import, 把源码写成临时 .mts, 用 node 的类型剥离
 * 跑断言。只测纯逻辑(analyzeBash / isInside / resolvePath), 不启动 pi。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(root, "extensions", "permission-gate.ts"), "utf8").replace(
  /^import .*@earendil-works\/pi-coding-agent.*$/gm,
  "",
);

const CHECK = `
import assert from "node:assert/strict";
import { analyzeBash, grant, isAllowed, isInside, resolvePath } from "./logic.mts";

const cwd = "/home/u/proj";
const cat = (cmd) => analyzeBash(cmd, cwd)?.category ?? null;

// --- 规则①: 删除, 任意路径都要确认(含 cwd 内) ---
assert.equal(cat("rm -rf /tmp/x"), "delete");
assert.equal(cat("rm file.txt"), "delete");
assert.equal(cat("rm -rf node_modules && npm install"), "delete");
assert.equal(cat("sudo rm -rf /var/log/old"), "delete");
assert.equal(cat("rmdir empty-dir"), "delete");
assert.equal(cat("find . -name '*.tmp' -delete"), "delete");
assert.equal(cat("xargs rm < list.txt"), "delete");
assert.equal(cat("git clean -fd"), "delete");
assert.equal(cat("gio trash /tmp/a"), "delete");
assert.equal(cat("unlink /tmp/symlink"), "delete");
assert.equal(cat("shred -u /tmp/secret"), "delete");
assert.equal(cat("grep -r rm ."), null); // rm 只是参数, 不误报
assert.equal(cat("npm unlink pkg"), null); // 不是文件删除

// --- 规则②: 越界(含读) ---
assert.equal(cat("cat /etc/passwd"), "read");
assert.equal(cat("cat ./local-file.txt"), null);
assert.equal(cat("cat sub/a.txt"), null);
assert.equal(cat("ls /home/u/proj"), null); // cwd 内的绝对路径
assert.equal(cat("less /var/log/syslog"), "read");
assert.equal(cat("cat ~/.ssh/id_rsa"), "read");
assert.equal(cat("cat $HOME/.bashrc"), "read");
assert.equal(cat("cat $PWD/../outside"), "read");
assert.equal(cat('grep -rn root "/etc"'), "read");
assert.equal(cat("cd /opt && ls"), "other");
assert.equal(cat("cd .. && pwd"), "other");
assert.equal(cat("cp /etc/hosts /tmp/h"), "write");
assert.equal(cat("mv file.txt /tmp/"), "write");
assert.equal(cat("echo hello > /tmp/out.txt"), "write");
assert.equal(cat("echo hello >> /home/x/log.txt"), "write");
assert.equal(cat("mkdir -p /tmp/newdir"), "write");
assert.equal(cat("curl -o /tmp/f https://x.com"), "write");
assert.equal(cat("node server.js"), null);
assert.equal(cat("npm install"), null);
assert.equal(cat("git status"), null);
assert.equal(cat("ls | head -3"), null);
assert.equal(cat("python3 -c \\"open('/etc/passwd').read()\\""), "other");
assert.equal(cat("bash /tmp/script.sh"), "other");
assert.equal(cat("docker run -v /host/dir:/c image"), "other");

// --- 动态路径兜底($()/反引号) ---
assert.equal(cat("rm -rf $(cat list)"), "delete");
assert.equal(cat("echo hi > $(mktemp)"), "write");

// --- targets = 解析后的绝对路径 ---
assert.deepEqual(analyzeBash("rm -rf /etc/hosts", cwd)?.targets, ["/etc/hosts"]);
assert.deepEqual(analyzeBash("rm -rf build", cwd)?.targets, []); // cwd 内删除: 没有路径目标
assert.deepEqual(analyzeBash("cat /etc/passwd", cwd)?.targets, ["/etc/passwd"]);

// --- isInside ---
assert.equal(isInside(cwd, cwd), true);
assert.equal(isInside(cwd, "/home/u/proj/a/b"), true);
assert.equal(isInside(cwd, "/home/u/proj2"), false);
assert.equal(isInside(cwd, "/home/u"), false);
assert.equal(isInside("/tmp", "/tmp/does-not-exist-pgate"), true); // 不存在的路径也要判对
assert.equal(resolvePath("~/x", cwd).startsWith("/"), true);

// --- 授权继承: 类别 × 目录, 主会话授权过的目录在别处(子代理)也直接放行 ---
grant("read", "/etc/passwd"); // 文件 → 记成父目录 /etc
assert.equal(isAllowed("read", "/etc/hosts"), true);
assert.equal(isAllowed("read", "/etc/ssl/openssl.cnf"), true);
assert.equal(isAllowed("read", "/var/log/syslog"), false);
assert.equal(isAllowed("write", "/etc/hosts"), false); // 类别不串
grant("delete", "/tmp"); // 目录 → 记成自身
assert.equal(isAllowed("delete", "/tmp/a/b"), true);
assert.equal(isAllowed("delete", "/home"), false);

console.log("test-logic OK");
`;

const dir = mkdtempSync(join(tmpdir(), "pgate-"));
writeFileSync(join(dir, "logic.mts"), src);
writeFileSync(join(dir, "check.mts"), CHECK);
const res = spawnSync(
  process.execPath,
  ["--no-warnings", "--experimental-strip-types", join(dir, "check.mts")],
  { stdio: "inherit" },
);
process.exit(res.status ?? 1);
