# Security Policy

## Supported versions

Security fixes are made on the latest `main` branch. Please update to the latest
commit before reporting an issue. Older commits and releases do not receive
separate security backports.

## Reporting a vulnerability

Please report suspected vulnerabilities privately to **heystarlink@gmail.com**
with the subject `codex-to-agents security report`.

Include the affected commit, operating system and Node.js version, a description
of the impact, and minimal reproduction steps. Use synthetic credentials and
redacted examples; do not send API keys, session tokens, private conversation
history, or unrelated workspace files.

Please avoid publishing vulnerability details in public issues or pull requests
before a fix or coordinated disclosure has been agreed with the maintainer.

## Local execution

The plugin and its configured executors can read and modify files and run local
commands according to their permissions. Use trusted executors and review their
permission settings before delegating work. Session credentials and local data
directories should not be committed to Git.
