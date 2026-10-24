# Warhead

A private coding agent for macOS. Warhead runs local models in-process through
Apple MLX or llama.cpp and owns its MCP task host. Ollama-compatible model tags
are read directly from Ollama's local model store; no Ollama app, daemon, or
server is needed.

```bash
./install.sh                 # installs the warhead-cli executable
warhead-cli
```

Requires macOS 14+, Apple silicon, Node 22.19+, 24.11+, or 26+, `npm` on
`PATH`, Swift 6/Xcode, and Xcode's Metal Toolchain
(`xcodebuild -downloadComponent MetalToolchain`). The first model turn compiles
the native runtime; subsequent runs reuse it. An MLX model can be downloaded
from Hugging Face on first use, while Ollama model tags must already exist in
`~/.ollama/models` (or `OLLAMA_MODELS`).

> Building is optional for development. The sources run directly through Node's
> native TypeScript stripping. `npm run build` emits plain JS to `dist/` for Node
> versions without that support, and `bin/warhead-cli.js` prefers `dist/` when
> present.

---

## Install

```bash
./install.sh                          # latest release into ~/.local
./install.sh --dry-run                # report what would happen, change nothing
./install.sh --version 0.1.0-rc.3     # pin a release
./install.sh --prefix /usr/local      # system-wide
./install.sh --from ./warhead-0.1.0-rc.3.tgz   # a tarball you already have
./install.sh uninstall                # remove the executable
```

`install.sh` is POSIX sh — no bashisms or global npm package install. It installs
the REA MCP runtime dependencies into Warhead's private directory. It places
the runtime in `<prefix>/lib/warhead` and links one executable at
`<prefix>/bin/warhead-cli`, so uninstalling is a two-file removal. It verifies
the install by running `warhead-cli --version` before reporting success.

`WARHEAD_PREFIX` and `WARHEAD_VERSION` are honoured as environment equivalents
of `--prefix` and `--version`, which is handy in CI.

**Integrity.** Releases publish a `.sha256` sidecar beside the tarball, and the
installer verifies it and refuses a mismatch. A sidecar that is *absent* is
reported and skipped rather than treated as failure — missing is not the same as
bad. The same applies to `--from`: drop a `.tgz.sha256` beside the tarball and
it is verified too.

**Version resolution** reads the GitHub releases *list*, not `/releases/latest`.
GitHub excludes prereleases from "latest", so on a project whose only releases
are RCs — which this one is — `/releases/latest` 404s and there is no latest to
find. Drafts are skipped and the newest by publish date wins.

Uninstall deliberately leaves `~/.config/warhead` and `~/.local/state/warhead`
alone; those hold your config and conversation transcripts. Pass `--purge` to
remove them too, which is irreversible.

Via npm instead:

```bash
npm install -g warhead     # also provides warhead-cli
npx warhead-cli
```

---

## Quick start

```bash
warhead-cli --help
warhead-cli            # start the agent REPL
warhead-cli rea --help # reverse-engineer-anything CLI (bundled REA)
```

Select a model with `WARHEAD_MODEL`, or add it to `model.candidates` in
`~/.config/warhead/config.json`:

```text
mlx:mlx-community/Qwen2.5-Coder-7B-Instruct-4bit
ollama:qwen2.5-coder:7b
gguf:/Users/me/Models/coder.gguf
```

### Remote MCP (e.g. TronScan)

Warhead can connect to Streamable HTTP MCP servers. By default it includes the
[TronScan MCP](https://mcp.tronscan.org/mcp) (TRON blockchain queries). Check
status with `/mcp` in the REPL. Use `mcp_search_tools` then `mcp_call_tool` to
call server tools. For an API key, set `TRONSCAN_API_KEY` in the environment
(the config references `${TRONSCAN_API_KEY}`). Edit
`~/.config/warhead/config.json` under `mcp.servers` to enable/disable servers or
add your own. See `src/skills/tronscan/SKILL.md` for common TRON queries.

`mlx:` loads MLX safetensors directly through Apple's MLX Swift libraries.
`ollama:` resolves the model's GGUF blob from the local Ollama store and loads
it through llama.cpp embedded in Warhead. `gguf:` loads an explicit GGUF file.
Local inference uses no HTTP endpoint; explicitly configured providers still do.
The MCP task host launches the bundled
REA task server as a managed child process, discovers its tools, and routes
mutating calls through Warhead's permission gate.

The tool probes its configured model on startup and reports what it found:

```
probing candidates (gpt-oss:120b-cloud, treyleo16/gpt-6-astra:latest)
  ok   gpt-oss:120b-cloud    752ms — emitted 1 tool call(s)
```

If a model is not tool-capable, it exits with a clear reason rather than
degrading silently.

For Ollama-compatible tags, Warhead reads the model's system prompt from its
local manifest when available. MLX models apply the chat template shipped with
the checkpoint; their own default system prompt is not extracted.

When no model is configured, startup discovers installed Ollama-store tags and
probes them through the local runtime. `WARHEAD_MODEL` selects exactly one model.

Probe budget matters: reasoning models spend generated tokens on hidden reasoning
before emitting content. With a small budget a perfectly capable model returns
empty and would be misclassified as having no tool support, so the probe
retries at a larger budget before concluding anything.

---

## Commands

| | |
|---|---|
| `/help` | command list |
| `/models` | list local and endpoint model tags — no inference request |
| `/model` | resolved model, active provider, probe history |
| `/model use <tag>` | probe that one tag and switch to it |
| `/model show <tag>` | show Ollama model metadata |
| `/model pull <tag>` | pull a model from the active Ollama endpoint |
| `/model delete <tag>` | delete a model from the active endpoint |
| `/model copy <from> <to>` | create a second tag for a model |
| `/model create <name> <Modelfile>` | create a model from a Modelfile |
| `/model version` | show the active Ollama version |
| `/model ps` | show currently running Ollama models |
| `/model pick [filter]` | probe matching installed models and choose one |
| `/model forget [tag]` | drop a candidate and forget its probe result |
| `/provider` | list providers, show the active one |
| `/provider add <name> <host> [--key-env VAR \| --key VALUE]` | register an endpoint |
| `/provider use <name>` | switch; re-resolves a model for the new host |
| `/provider default` | back to `$OLLAMA_HOST` or `localhost:11434` |
| `/provider remove <name>` | unregister |
| `/permissions` | current policy |
| `/permissions bash ask\|allow\|allowlist` | shell policy |
| `/permissions allow\|deny <tool>` | per-tool policy |
| `/permissions reset` | clear session-scoped grants |
| `/tools` | list available tools |
| `/todos` | current task list |
| `/transcripts` | transcript path and disk usage |
| `/clear` | forget conversation history |
| `/exit` | quit |

Ctrl-C cancels the running turn; a second press at idle exits.

---

## Models and providers

A **provider** is an optional Ollama-compatible HTTP endpoint for remote models.
Local MLX and GGUF models do not use providers or open a server connection.

Resolution order, most specific first:

1. the provider named by `providers.active`
2. `$OLLAMA_HOST`
3. `http://localhost:11434`

Config beats the environment because naming a provider is deliberate and an
ambient env var is not — but with no active provider configured, `$OLLAMA_HOST`
still applies, which is what keeps `OLLAMA_HOST=<host> warhead-cli` and the test
suite working.

```
/provider add lan 192.168.1.20:11434              # scheme optional
/provider add cloud https://ollama.com --key-env OLLAMA_API_KEY
/provider use cloud
```

**Credentials.** Prefer `--key-env`: the config stores only the variable's
*name* and the key is read from the environment at request time, so a config
that gets copied or committed cannot leak it. `--key` stores the secret inline
in plaintext, and the tool says so when you use it. Either way the key is sent
as `Authorization: Bearer …`, and a provider with no key sends no header at
all. `config.json` is written `0600`.

`OLLAMA_API_KEY` is honoured for the built-in provider too, so cloud tags work
without registering anything first. When using the built-in provider, an
authenticated model tag ending in `-cloud` automatically routes to
`https://ollama.com`; set `OLLAMA_CLOUD_HOST` to override that endpoint. An
explicit `/provider use ...` selection always takes precedence.

**Switching hosts re-resolves the model.** Tags are per-endpoint — one that
resolves locally commonly 404s elsewhere — so `/provider use` checks the new host
is answering, drops the remembered probe verdicts (they described the old one),
and resolves again.

The native Ollama management layer also exposes model metadata, pull, delete,
copy, generate, and embedding operations with the active provider's
authentication and a bounded request timeout. It also exposes Ollama version
and running-model (`/api/ps`) inspection for diagnostics and integrations.

### Picking a model

`/models` is free: it lists tags discovered in the local Ollama model store, merged
with what an optional endpoint reports, without probing anything. A tag present
in both is shown once, as `ollama:<tag>`, because that reference uses Warhead's
in-process runtime and keeps working when no daemon is running. `[not pulled]`
marks a tag Ollama has resolved but not downloaded — it reports a few KB, because
that is the manifest rather than the weights.

Probing is not free. Each probe is a request, and on a cloud endpoint a billed
one, so:

- `/model use <tag>` probes exactly one model.
- `/model pick` filters **before** probing, so `/model pick oss` costs one
  request instead of one per installed model.
- An unfiltered `/model pick` against more than a handful of models asks first,
  and tells you how to narrow it.

Scans run at most 4 probes concurrently — previously every installed model was
probed at once, which on a large library is enough to trip rate limits.

---

## Tools

| Tool | Mutating | Notes |
|---|---|---|
| `read_file` | no | line-numbered output, `offset`/`limit` paging |
| `glob` | no | patterns against the relative path, newest first |
| `grep` | no | `file:line:content`; `include` follows ripgrep semantics |
| `todo` | no | the agent's own task list |
| `write` | **yes** | refuses to overwrite without `overwrite: true` |
| `edit` | **yes** | exact-string replace; ambiguity is an error, never a guess |
| `multi_edit` | **yes** | atomic: one malformed entry fails the whole call |
| `bash` | **yes** | `sh -c`, own process group, killed on timeout |
| `web_search` | no | bounded DuckDuckGo search; set `WARHEAD_SEARCH_URL` for a compatible proxy |
| `rea_search_tasks` | no | search the bundled REA task catalog and return exact names/schemas |
| `rea_run_task` | **yes** | run one REA task; approval is required because the catalog includes live execution |
| `mcp_search_tools` | no | search tools on connected remote MCP servers (e.g. TronScan) |
| `mcp_call_tool` | varies | call a tool on a connected MCP server; may require approval if not read-only |

For shipped binaries, packages, firmware, browser/Electron targets, or runtime
behavior, the agent searches the bundled REA catalog and then runs the matching
task. REA is optional at the tool layer: if its MCP server cannot start, the
dedicated coding tools still work, and ordinary source-repository analysis does
not need it. Task output retains evidence identifiers and limits, and static
evidence is kept distinct from runtime observation.

---

## Permissions

`src/perm/gate.ts` is the only thing that authorizes a tool call. The model is
remote and the files it reads are untrusted, so a prompt injection in a source
file can make it *request* a write or a shell command — this is where that
request is judged.

- Policies are read from config **at call time**, so `/permissions` takes effect
  on the very next call.
- "Always allow" at the approval prompt is **session-scoped and never persisted**.
  Silently writing "always allow write" into a config file is a footgun that
  outlives the session that granted it. `/permissions reset` clears it.
- A **denial is sticky for the session**, so an injection cannot simply re-ask.
- The bash allowlist **splits on `;`, `&&`, `||`, `|` and newlines and requires
  every segment to match**, so `git status; rm -rf ~` is rejected. Commands
  containing substitution, redirection, `eval`, `source`, or a pipe into an
  interpreter can never be auto-approved.

Config lives at `~/.config/warhead/config.json`. Bash policy defaults to `ask`;
write/edit/multi_edit default to `ask`.

---

## Context and transcripts

Long conversations are compacted between turns (never mid-turn — dropping a tool
result whose `tool_calls` parent was removed corrupts the next request). A
summary that would be *larger* than the text it replaces is discarded; the point
is to shrink. Threshold and retained-message count are configurable.

Every session is logged as JSONL under `~/.local/state/warhead/sessions/`, so you
can `grep` and `tail` it. LRU-evicted above a configurable total (256 MB
default); large tool results are truncated on the way in.

---

## Development

```bash
HUSKY=0 npm ci --prefix rea # install the bundled REA build toolchain from a source checkout
npm run build         # build REA and emit Warhead's plain JS to dist/
npm run typecheck     # tsc --noEmit
npm test              # unit tests, deterministic
npm run test:live     # 13 cases against the real model
npm run check:encoding # NUL bytes / invalid UTF-8 in tracked sources
npm run verify        # typecheck + unit
npm run test:install  # pack, then install the tarball and run it
```

`npm run test:install` exercises the real release path rather than a simulation:
it packs, installs the resulting tarball into a throwaway prefix, asserts
`warhead-cli --version` reports the packed version, and uninstalls. That is what
catches a `bin` rename or a `files` omission — a launcher that no longer exists,
or a tarball missing `dist/`, still passes every unit test.

The unit suite runs against a fake Ollama (`test/helpers/fakeOllama.ts`) — fast
and deterministic. That is exactly why it missed a bug where compaction was
permanently inert: the summarizer was handed an already-aborted signal, which no
test that didn't drive the real REPL could see. **`test:live` exists to catch
that class of defect** — it drives the real model and asserts on tool usage and
filesystem state rather than prose, since the model is non-deterministic. Cases
whose outcome depends on which tool the model chooses are marked `flaky` and
reported separately.

### Layout

```
install.sh    POSIX installer: fetch a release, link warhead-cli, verify
bin/         warhead-cli.js launcher (prefers dist/, falls back to src/)
native/      warhead-runtime: Swift package for MLX and llama.cpp inference
rea/         bundled REA source, built dist/, task catalog, and CLI
scripts/     build.mjs, test-install.sh, check-encoding.mjs
src/
  cli/         repl.ts, main.ts (probe/demo entrypoint)
  model/       client.ts (streaming, tool-call assembly), probe.ts,
               local-models.ts (mlx:/gguf:/ollama: refs),
               native-runtime.ts (Swift runtime process), provider.ts
  rea/         mcp-client.ts (bundled REA task server)
  skills/      vendored skills available to the agent
  agent/       loop.ts (turn cycle, stop conditions)
  tools/       read, glob, grep, todo, write, edit, multi_edit, bash
  perm/        gate.ts
  context/     compact.ts, transcript.ts
  prompt/      system.ts  (capability text is derived, never hardcoded)
  config.ts
test/
  *.test.ts              unit, against the fake server and temp model stores
  helpers/fakeOllama.ts
  live/                  real-model regression suite
```

### Releasing

Push a `v`-prefixed tag and the `release` workflow builds, verifies, packs, and
attaches `warhead-<version>.tgz` plus its `.sha256` to a GitHub release. It
refuses to run if the tag and `package.json` version disagree — otherwise the
release would advertise one version and `--version` would report another.

```bash
npm version prerelease --preid=rc    # -> 0.1.0-rc.4
git commit -am "..." && git tag v0.1.0-rc.4 && git push --follow-tags
```

The assets must be named exactly `warhead-<version>.tgz`; `install.sh` derives
that name from the tag by stripping the leading `v`, so both `v0.1.0-rc.4` and
`0.1.0-rc.4` resolve to the same file.

**The workflow does not publish to npm, deliberately.** `LICENSE` is proprietary,
so the package must not reach the public registry as a side effect of cutting a
GitHub release. `publishConfig.tag` is pinned to `rc` so a bare `npm publish`
cannot land on `latest` by accident. Publishing to npm is a manual, deliberate
step — and only makes sense against a private registry.

### Known limitations

- **POSIX only.** `bash` spawns `sh -c` and signals process groups; Windows will
  not work.
- Tool descriptions and argument aliases are tuned for `gpt-oss-120b`.
- Tools run **sequentially** within a turn. The prompt tells the model it may
  batch calls, but correctness is preferred over latency since emitted calls can
  depend on each other's results.
- Not fuzz-tested against adversarial tool-argument input.
- **Read tools are auto-allowed.** `read_file`/`glob`/`grep` never prompt, so the
  agent can read any file the process can — including `~/.ssh/id_rsa`. That is a
  deliberate choice: reads are reversible, and every call is recorded in the
  transcript. Gating reads is a one-line change
  (`permissions.alwaysAllow`) if you want it.
- Changing a default does not migrate an existing `config.json`. Delete stale
  keys by hand after upgrading, or delete the file to regenerate it.
