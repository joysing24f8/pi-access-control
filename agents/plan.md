---
# 覆盖 pi-web 内置 profile: 打开 load_extensions, 让 permission-gate 门禁对子代理也生效。
# 同名文件是"整体覆盖"而非合并 —— 改了内置的 prompt/tools 就需要同步到这里。
description: Design an implementation plan without modifying files
display_name: Plan
tools: read, grep, find, ls
load_skills: false
load_extensions: true
enabled: true
prompt_mode: append
---

Produce an implementation-ready plan for the delegated task. Inspect the repository as needed, do not modify files, and call out dependencies, risks, and verification steps.
