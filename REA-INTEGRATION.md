=== REA FULL INCORPORATION INTO WARHEAD ===
Status: ACTIVE (REA builds, runs, and is wired into the CLI)

User explicitly selected: FULL MERGE WITH BRIDGES (override fail-closed rules)

INTEGRATION
---
0. Vendored upstream: https://github.com/morluto/rea.git at
   `932fbb7d84a9a995b9aee3c1be7da05a8c4d7bbb` (rea-agents 6.7.0).
   The nested `.git` directory is removed so Warhead's repository owns the
   files; `rea/.gitignore` still excludes generated `rea/dist/`, `rea/skills/`,
   `node_modules/`, `.turbo/`, and `.cache/`. Run the build below to regenerate
   `rea/dist/` before packing. Upstream's five `third_party/` submodules
   (binwalk, ghidra-nativeaot, jadx-headless-mcp, unblob, wakaru) are not
   initialized; tasks that require those vendored sources need them checked out
   separately.

1. `rea/` is vendored in full: source, docs, skills, bridge (native/,
   ghidra/, android/, process/, cutter/, ...), scripts, and AGENTS.md.
   `HUSKY=0 npm ci --prefix rea && npm run build:cached --prefix rea` has been
   run; `rea/dist/` is current for this checkout.

2. `bin/warhead-cli.js`
   - Routes `warhead-cli rea [...]` (and `--rea`) straight to
     `rea/scripts/rea.mjs`. This lives in the launcher because the launcher
     otherwise starts the argument-less REPL.
   - `--help` documents the subcommand.

3. `src/cli/main.ts`
   - The diagnostic entrypoint (`npm start`, `--scan`, `--tools`) also accepts
     `rea`/`--rea` and spawns the same script, so both entrypoints agree.

4. `src/rea/mcp-client.ts`
   - Starts `rea/scripts/rea.mjs mcp` as a private stdio child of the REPL and
     stops it on exit.
   - Exposes two model-facing tools: `rea_search_tasks` (search the 218-task
     catalog) and `rea_run_task` (run one exact task).
   - Read-only/destructive classification: the entire catalog is treated as
     mutating because tasks range from analysis to live execution, so every
     `rea_run_task` call goes through the approval gate.
   - Permission "always" decisions are scoped per task, not to the whole
     dispatcher.

5. `src/skills/reverse-engineer-anything/`
   - Vendored skill for agents that load local skills.

6. Packaging
   - `package.json` ships `rea`, its deterministic `npm-shrinkwrap.json`, and
     the native runtime sources, and declares `rea-agents` as a `file:./rea`
     dependency.
   - `install.sh` installs REA's application dependencies from its vendored
     lockfile with `npm ci` and copies `rea/`.
   - Release/verify workflows run `HUSKY=0 npm ci --prefix rea`.

VALIDATION
---
- `npm run build` succeeds (REA cached build + Warhead `dist/`).
- `npm test` passes (including local-model resolution and per-task REA
  permission-scope tests).
- `npm run test:install` passes (23 checks; now also verifies `rea --version`).
- `warhead-cli rea --version` reports 6.7.0 from an installed tarball.
- `ReaMcpClient` discovers both tools and `rea_search_tasks` returns catalog
  results.
- Swift runtime sources pass `swiftc -frontend -parse`; a full `swift build` was
  not run in this checkout because Xcode's Metal Toolchain is absent (see below).

ENVIRONMENT REQUIREMENT
---
Local MLX/GGUF inference compiles the Swift runtime on first use. That build
needs Xcode's Metal Toolchain, which is a separate download in current Xcode:

  xcodebuild -downloadComponent MetalToolchain

Without it, MLX's Metal shaders fail to compile and the runtime reports an
actionable error. Ollama-compatible HTTP providers do not need the native
runtime.
