// 临时自测脚本: 验证 permission-gate.ts 的判定逻辑
//
// 运行前提: 项目下需要能解析 @earendil-works/pi-coding-agent 包,
// 已建立软链 node_modules/@earendil-works/pi-coding-agent -> pi-web 内的同名包,
// 仅用于本地测试(pi 运行时自己会注入该包, 与这个软链无关)。
//
// 用法: node --experimental-strip-types test-logic.mjs <cwd>
import { analyzeBash, isInside } from "./permission-gate.ts";
import * as path from "node:path";

const cwd = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const inside = (p) => path.join(cwd, p);

const cases = [
  // [命令, 期望: "DELETE" | "READ" | "WRITE" | "OTHER" | null]
  ["rm -rf /tmp/x", "DELETE"],
  ["rm file.txt", "DELETE"],
  ["rm -rf node_modules && npm install", "DELETE"],
  ["sudo rm -rf /var/log/old", "DELETE"],
  ["rmdir /tmp/empty", "DELETE"],
  ["rmdir empty-dir", "DELETE"],
  ["find /tmp -name '*.log' -delete", "DELETE"],
  ["find . -name '*.tmp' -delete", "DELETE"],
  ["xargs rm < list.txt", "DELETE"],
  ["find / -exec rm {} +", "DELETE"],
  ["git clean -fd", "DELETE"],
  ["gio trash /tmp/a", "DELETE"],
  ["unlink /tmp/symlink", "DELETE"],
  ["shred -u /tmp/secret", "DELETE"],
  ["grep -r rm .", null], // rm 是参数, 不误报
  ["npm unlink pkg", null], // 不是文件删除
  ["echo hello", null],
  ["cat /etc/hosts", "READ"],
  ["cat ./local-file.txt", null],
  ["less /var/log/syslog", "READ"],
  ["cd /opt && ls", "OTHER"],
  ["cd .. && pwd", "OTHER"],
  ["ls /usr/lib", "READ"],
  ["source ~/.profile", "READ"],
  ["cp /etc/hosts /tmp/h", "WRITE"],
  ["mv file.txt /tmp/", "WRITE"],
  ["echo hello > /tmp/out.txt", "WRITE"],
  ["echo hello >> /home/x/log.txt", "WRITE"],
  ["mkdir -p /tmp/newdir", "WRITE"],
  ["curl -o /tmp/f https://x.com", "WRITE"],
  ["export FOO=/tmp/x", null], // 环境变量赋值, 无文件操作, 不拦
  ["node server.js", null],
  ["npm install", null],
  ["git status", null],
  ["python3 -c \"open('/etc/passwd').read()\"", "OTHER"],
  ["bash /tmp/script.sh", "OTHER"],
  ["docker run -v /host/dir:/c image", "OTHER"],
  ["ls /home/joysing/workspace/pi-tools/local-permission-manager", null], // cwd 内绝对路径
];

const label = { read: "READ", write: "WRITE", delete: "DELETE", other: "OTHER" };
let pass = 0;
let fail = 0;
for (const [cmd, want] of cases) {
  const f = analyzeBash(cmd, cwd);
  const got = f ? label[f.category] : null;
  const ok = got === want;
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL  want=${want} got=${got}  cmd=${cmd}${f ? "  targets=" + JSON.stringify(f.targets) : ""}`);
  }
}

// isInside 用例
const insideCases = [
  [inside("a/b/c"), "inside"],
  [inside("a"), "inside"],
  [cwd, "inside"],
  [path.join(cwd, "..", "other"), "outside"],
  ["/etc", "outside"],
];
for (const [p, want] of insideCases) {
  const got = isInside(cwd, p) ? "inside" : "outside";
  if (got === want) pass++;
  else {
    fail++;
    console.log(`FAIL isInside want=${want} got=${got} p=${p}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed (cwd=${cwd})`);
process.exit(fail ? 1 : 0);
