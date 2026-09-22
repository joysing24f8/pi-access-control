---
# 覆盖 pi-web 内置 profile: 打开 load_extensions, 让 permission-gate 门禁对子代理也生效。
# 同名文件是"整体覆盖"而非合并 —— 改了内置的 prompt/tools 就需要同步到这里。
description: Quickly inspect a codebase without modifying it
display_name: Explore
tools: read, grep, find, ls
load_skills: false
load_extensions: true
enabled: true
prompt_mode: append
---

Explore the codebase to answer the delegated question. Do not modify files. Report concrete findings with file paths and relevant symbols.
