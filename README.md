# Warhead

The exclusive proprietary in-house agent for
[HindSight Reverse Engineering Studio](https://github.com/BrokenPorkMachine/HindSight/),
by BrokenPorkMachine. Warhead supports evidence-based reverse engineering,
investigation automation, and Studio development using local or cloud models
served by [Ollama](https://ollama.com). Model default system prompts are preserved.

Warhead follows HindSight's investigation workflow: orient, explain, execute,
prove, automate. Findings retain provenance, address spaces, and uncertainty.

## HindSight investigation context

Export an investigation or target session as JSON from HindSight, then start:

```bash
WARHEAD_HINDSIGHT_CONTEXT=/path/to/investigation.json warhead-cli
```

Ask Warhead to inspect the export. Its `hindsight_context` tool reads JSON objects
up to 256 KiB and preserves the original fields and evidence IDs. A path can also
be supplied directly to the tool. Export a narrower snapshot if it exceeds the
limit. Exports are untrusted evidence; schema compatibility and freshness are
not automatically verified. This integration reads snapshots; it does not attach
to the running macOS app, control its debugger, or install extensions.

Warhead's shell and editing tools support Studio development and approved local
research workflows. The existing permission gate governs execution and changes.
HindSight's Python API v2 extensions remain hosted by its Coordinator; Warhead
does not bypass that host or its capability declarations.

**Zero runtime dependencies.** The Ollama API is plain HTTP over
`localhost:11434`, so there is nothing to install.

```bash
./install.sh                 # installs the warhead-cli executable
warhead-cli
```

Requires Node ≥ 20 and a running Ollama with a tool-capable model. Installed
from a release tarball the tool runs from `dist/` (plain JS); running from a
clone without a build needs Node ≥ 22.6, for its native TypeScript stripping.

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

`install.sh` is POSIX sh — no bashisms, no build step, no global npm install.
It places the runtime in `<prefix>/lib/warhead` and links one executable at
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

Warhead is proprietary and reserved for HindSight's in-house use. The package is
marked `private` to prevent accidental npm publication. Distribute approved
internal builds through the existing tarball installer.

---

## Quick start

```bash
ollama pull gpt-oss:120b-cloud      # or any model that emits tool calls
warhead-cli
```

With no default selected, startup discovers models across configured endpoints,
`OLLAMA_HOST`, local Ollama, and Ollama Cloud when `OLLAMA_API_KEY` is set.
It probes discovered models for tool support and offers a picker showing each
model's endpoint. The selection is saved as the default model and provider.
Only models exposed by an endpoint's `/api/tags` are discoverable.

Once a default is selected, startup tries configured candidates in order and
falls back to scanning the active endpoint if they fail. `/model forget` clears
the selection so the next startup discovers all surfaces again.

The model's **own default system prompt is preserved** and placed ahead of the
agent's instructions, because sending a `system` message replaces the Modelfile
default — dropping it would discard behaviour the model was tuned with (for
gpt-oss, its reasoning-depth protocol). Cloud tags expose no Modelfile prompt, so
this is best-effort; see `src/model/modelfile.ts`.

Probe budget matters: reasoning models spend generated tokens on hidden reasoning
before emitting content. With a small budget a perfectly capable model returns
empty and would be misclassified as having no tool support, so the probe
retries at a larger budget before concluding anything.

---

## Commands

| | |
|---|---|
| `/help` | command list |
| `/models` | list downloaded models — no probing, no requests |
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

A **provider** is a named Ollama endpoint. Every one speaks the same `/api/chat`
protocol, so switching between a local daemon, a box on the LAN, and a cloud
gateway needs no new streaming or tool-call code. Non-Ollama vendors do not fit
this shape — OpenAI streams SSE `tool_calls` deltas where Ollama streams NDJSON
frames — so they would need a real adapter layer, not another entry in a list.

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

`/models` is free: it lists what the endpoint reports without probing anything.
`[not pulled]` marks a tag Ollama has resolved but not downloaded — it reports a
few KB, because that is the manifest rather than the weights.

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
| `hindsight_context` | no | read an exported HindSight JSON snapshot, up to 256 KiB |
| `todo` | no | the agent's own task list |
| `write` | **yes** | refuses to overwrite without `overwrite: true` |
| `edit` | **yes** | exact-string replace; ambiguity is an error, never a guess |
| `multi_edit` | **yes** | atomic: one malformed entry fails the whole call |
| `bash` | **yes** | `sh -c`, own process group, killed on timeout |
| `web_search` | no | bounded DuckDuckGo search; set `WARHEAD_SEARCH_URL` for a compatible proxy |

The agent is also instructed to use REA (Reverse Engineer Anything) through the
approved `bash` workflow for shipped binaries, packages, firmware, and
browser/Electron runtime investigations. It should begin with a summary,
preserve evidence identifiers and limitations, and distinguish static evidence
from runtime observation. REA is optional; ordinary source-repository analysis
uses Warhead's native coding tools.

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
npm run build         # emit plain JS to dist/
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
scripts/     build.mjs, test-install.sh, check-encoding.mjs
src/
  cli/         repl.ts, main.ts (probe/demo entrypoint)
  model/       client.ts (streaming, tool-call assembly), probe.ts,
               provider.ts (named endpoints, credential resolution)
  agent/       loop.ts (turn cycle, stop conditions)
  tools/       read, glob, grep, todo, write, edit, multi_edit, bash
  perm/        gate.ts
  context/     compact.ts, transcript.ts
  prompt/      system.ts  (capability text is derived, never hardcoded)
  config.ts
test/
  *.test.ts              unit, against the fake server
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

**The workflow does not publish to npm.** Warhead is proprietary and its package
is marked `private: true`, so npm publication is blocked. Release tarballs remain
the internal distribution format; the license governs redistribution.

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
