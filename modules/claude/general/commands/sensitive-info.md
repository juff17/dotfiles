---
description: Do not read files that may hold secrets; pass the same rule to subagents.
---

Treat this workspace as containing sensitive credentials. Do not read, open, cat, grep, or otherwise access any file likely to hold secrets — `.env` files, credential and config files, keychains, certificates, anything that could contain API keys, tokens, or passwords. Use your judgement and err toward not reading when unsure; this covers many file types, not a fixed list. Do not attempt to work around these restrictions, and give any subagent you spawn these same instructions.
