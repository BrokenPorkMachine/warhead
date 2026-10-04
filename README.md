# Warhead

A private agentic coding tool that has no alignment guard rails. Runs 
against models served by [Ollama](https://ollama.com), local or cloud 
models maintaining their default system prompt as an addition to the 
agentic payload.

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
./install.sh --version 0.1.0-rc.3     # pin a release
./install.sh --prefix /usr/local      # system-wide
./install.sh --from ./warhead-0.1.0-rc.3.tgz   # a tarball you already have
./install.sh uninstall                # remove the executable
```

`install.sh` is POSIX sh — no bashisms, no build step, no global npm install.
It places the runtime in `<prefix>/lib/warhead` and links one executable at
`<prefix>/bin/warhead-cli`, so uninstalling is a two-file removal. It verifies
the install by running `warhead-cli --version` before reporting success.

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
ollama pull gpt-oss:120b-cloud      # or any model that emits tool calls
warhead-cli
```

The tool probes its candidate models on startup and reports what it found:

```
probing candidates (gpt-oss:120b-cloud, treyleo16/gpt-6-astra:latest)
  ok   gpt-oss:120b-cloud    752ms — emitted 1 tool call(s)
```

If none work it scans your installed models, probes each, and offers a picker.
If none pass, it exits with a per-model reason rather than degrading silently.

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
| `/tools` | available tools |
| `/model` | resolved model, candidates, recorded probe results |
| `/model pick` | probe installed models and choose one |
| `/permissions` | current policy |
| `/permissions bash ask\|allow\|allowlist` | shell policy |
| `/permissions allow\|deny <tool>` | per-tool policy |
| `/permissions reset` | clear session-scoped grants |
| `/todos` | current task list |
| `/transcripts` | transcript path and disk usage |
| `/clear` | forget conversation history |
| `/exit` | quit |

Ctrl-C cancels the running turn; a second press at idle exits.

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
npm test              # 58 unit tests, deterministic
npm run test:live     # 13 cases against the real model
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
scripts/     build.mjs
src/
  cli/         repl.ts, main.ts (probe/demo entrypoint)
  model/       client.ts (streaming, tool-call assembly), probe.ts
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
