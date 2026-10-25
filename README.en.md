# Codex to Agents

[简体中文](README.md) | **English**

Codex to Agents is a Codex plugin that delegates concrete coding tasks to **DeepSeek Harness (DSH)**, **Hermes Agent CN Desktop**, or **Qoder CLI**. Codex plans the work, follows up, and verifies the result, while a local Agents dashboard in Codex controls whether and where tasks are dispatched. The dashboard also manages SDD task documents and checks for plugin updates.

It is for people who already use Codex together with another coding agent and want to stop copying prompts and results between tools.

## What it does

| You want to | How it works |
|---|---|
| Hand a scoped coding task to an agent | State the goal, working directory, and acceptance checks in Codex; Codex saves a work order and dispatches it |
| Decide when work is dispatched | In the Agents dashboard, toggle Auto-dispatch and choose the executor, model, reasoning effort, and new-session permission |
| Follow progress or ask for changes | Ask Codex for status, or continue in the executor's native session |
| Verify the delivery | Codex reads the result, checks the files, and runs the relevant verification |

You keep control of the dispatch switch and the executor; Codex decomposes the request and verifies the outcome; the agent does the actual implementation.

## Requirements

- A local **macOS** desktop workflow. This is the only workflow this guide covers; other operating systems are not verified.
- **Node.js 22.19+** and npm.
- The Codex desktop app and CLI, with support for plugins, the MCP Apps dashboard, and plugin hooks.
- At least one executor: DSH desktop app, Hermes Agent CN Desktop, or Qoder CLI, already configured with a model that works in its native chat (for Qoder CLI: installed and logged in).

Accounts, model access, and usage stay with each executor. This project does not read model API keys or credentials.

## Quick start

### 1. Clone and install dependencies

```bash
git clone https://github.com/sneezeforever/codex-to-agents.git
cd codex-to-agents
npm ci
mkdir -p "$HOME/codex-agents-demo"
```

Keep the repository directory and the Node.js executable in place; the plugin uses them at runtime.

### 2. Connect an executor

Pick at least one route below. You can also enable several executors side by side. `--directory` is the default task directory and must be an absolute path.

**DSH** — open DSH first, then run:

```bash
node src/command.mjs enable --provider '*' \
  --directory "$HOME/codex-agents-demo"
```

`'*'` allows every model provider loaded in DSH; the model list follows your DSH configuration. The command installs a local DSH execution plugin—restart DSH if it does not load. To limit dispatch to specific providers, replace `'*'` with real IDs such as `deepseek-account` (separate multiple IDs with commas).

**Hermes** — open Hermes and confirm it can chat normally first, then run:

```bash
node src/command.mjs enable --executor hermes \
  --directory "$HOME/codex-agents-demo"
```

It connects to `http://127.0.0.1:9120` by default and uses Hermes' current default model.

**Qoder CLI** — install and log in with the official CLI:

```bash
curl -fsSL https://qoder.com/install | bash
qodercli login
qodercli --list-models
node src/command.mjs enable --executor qoder \
  --directory "$HOME/codex-agents-demo"
```

The Qoder CLI and its login are managed by Qoder; this project does not install Qoder software or read its credentials. If the CLI is not on `PATH`, add `--qoder-executable /absolute/path/to/qodercli`.

New installations use a local **stdio** connection by default; `--transport http` is optional on `enable` and `plugin-install`. An explicit transport choice is saved and reused by later installs and updates.

### 3. Install the Agents dashboard

```bash
node src/command.mjs plugin-install
```

Then:

1. Restart Codex so the client loads the plugin and connections.
2. When Codex asks, review and trust the Agents dashboard's `UserPromptSubmit` hook (in Codex CLI, use `/hooks`).
3. Start a new session and open the **Agents dashboard** from the left.
4. Select the connected **DSH**, **Hermes**, or **Qoder**, choose a model or follow the executor default, then turn on **Auto-dispatch**. Saved settings apply from the next message.

If the dashboard shows "pending", handle the hook prompt first: trust the hook in `/hooks`, then reload the old session. Trusting the hook once is enough for daily switching; there is no need to restart for every model change.

### 4. Try a first dispatch

In a new Codex session with auto-dispatch on, send:

```text
Create hello.js in the configured default task directory and make it print Hello, World!.
Only modify hello.js. Hand it to the selected agent, then check the file and actually run it to verify the result.
```

Codex scopes the task and saves a work order, the agent executes it in a native session, and Codex checks the file and output before reporting back. Verify it yourself:

```bash
node "$HOME/codex-agents-demo/hello.js"
```

A saved work order means the task was queued, not that it succeeded; check the file, the execution output, and the acceptance result.

## Data, accounts, and boundaries

- Work orders, progress, and task documents are stored locally. The task directory does not provide file isolation; the executor's own permissions still govern file changes and tool execution.
- Executor accounts, models, quotas, and usage remain with the executor. This project uses existing executor configuration and does not read API keys or credentials.
- Anonymous usage statistics are enabled by default until you save a choice, and you can turn them off at any time in the dashboard. Only a random install ID and the plugin version are sent—not code, prompts, project paths, task content, or accounts.
- Turning off auto-dispatch stops new dispatches; it does not cancel tasks already running on the executor.
- This project does not automatically choose the best model, commit or merge code, or provide remote multi-machine scheduling.
- Qoder sessions are not synced to the Qoder desktop sidebar; unsupported session operations are rejected explicitly.

Claims about speed, quota, or cost savings are not verified—actual performance depends on the executor, model, and provider.

## Learn more

- [Advanced manual](docs/advanced.md) (Chinese): configuration parameters, work orders and MCP tools, backend management, updates, and development checks.
- [Upgrade an existing install](docs/upgrading.md) (Chinese).
- [Design notes](DESIGN.md) (Chinese): shared backend, persistence, recovery strategy, and interface references.
