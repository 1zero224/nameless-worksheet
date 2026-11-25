# CLAUDE.md

本项目的编码代理执行规范、分层验证、防篡改与验证戳约定统一维护在 [AGENTS.md](AGENTS.md)，Diff 触发的可靠性审查清单维护在 [REVIEW.md](REVIEW.md)。

动手前与提交前必读：

1. [AGENTS.md](AGENTS.md) — 廉价检查优先、3 轮失败升级人类、零容忍 flaky、防篡改、验证戳。
2. [REVIEW.md](REVIEW.md) — 根据 `git diff` 触发的专项可靠性检查项（始终以 `main` 分支版本为准）。
3. [GLOSSARY.md](GLOSSARY.md) — 严格领域术语表。
4. [.claude/skills/verify/SKILL.md](.claude/skills/verify/SKILL.md) 与 [docs/feature-map.md](docs/feature-map.md) — 真跑应用冒烟与浏览器交互验证指南。
