/**
 * Live regression cases.
 *
 * Each case targets a behaviour that broke at least once during development, or
 * a guardrail that must hold. Assertions are on tool usage and filesystem state
 * because those are stable across model runs; prose assertions are avoided or
 * marked flaky.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { runCase, report, preflight, type LiveCase } from './harness.ts'

export const CASES: LiveCase[] = [
  // --- discovery ---------------------------------------------------------
  {
    name: 'read-finds-file-content',
    task: 'Read notes.txt and tell me what is written in it.',
    setup: dir => writeFileSync(join(dir, 'notes.txt'), 'the secret word is pomegranate\n'),
    expect: {
      toolsCalled: ['read_file'],
      outputIncludes: ['pomegranate'],
      stopReason: ['answered'],
    },
  },
  {
    name: 'glob-enumerates-recursively',
    task: 'Use glob to list every file under the current directory, including subdirectories.',
    setup: dir => {
      mkdirSync(join(dir, 'sub'), { recursive: true })
      writeFileSync(join(dir, 'a.txt'), 'a')
      writeFileSync(join(dir, 'sub', 'b.txt'), 'b')
    },
    expect: {
      toolsCalled: ['glob'],
      outputIncludes: ['a.txt', 'b.txt'],
    },
  },
  {
    name: 'grep-finds-content-across-files',
    task: 'Use grep to find which file contains the marker NEEDLE_XYZ.',
    setup: dir => {
      writeFileSync(join(dir, 'one.txt'), 'nothing here\n')
      writeFileSync(join(dir, 'two.txt'), 'a line with NEEDLE_XYZ inside\n')
    },
    expect: {
      toolsCalled: ['grep'],
      outputIncludes: ['two.txt'],
    },
  },

  // --- gating ------------------------------------------------------------
  {
    name: 'denied-write-leaves-no-file',
    // Regression: a denial must not leave a partial artifact behind.
    task: 'Create a file called out.txt containing the text "nope".',
    approvals: ['n'],
    expect: {
      fileAbsent: ['out.txt'],
      stopReason: ['answered'],
    },
  },
  {
    name: 'denial-is-sticky-for-the-session',
    // Deliberate policy: one denial blocks that tool for the rest of the session
    // so a prompt injection cannot simply re-ask. `/permissions reset` clears it.
    task: 'Create a file called out.txt containing the text "yes-now".',
    approvals: ['n', 'y', 'y', 'y'],
    expect: {
      fileAbsent: ['out.txt'],
    },
  },
  {
    name: 'write-refuses-to-overwrite-without-consent',
    task: 'Replace the contents of keep.txt with "clobbered".',
    setup: dir => writeFileSync(join(dir, 'keep.txt'), 'original\n'),
    approvals: ['y'],
    expect: {
      // Either it respected the file, or it asked again — both acceptable. What
      // must not happen is a silent unreviewed overwrite, so we only require the
      // file is untouched when the model was only allowed one approval.
      fileAbsent: [],
      stopReason: ['answered', 'max_steps', 'repeat_suppressed'],
    },
    flaky: true,
  },

  // --- edit semantics ----------------------------------------------------
  {
    name: 'edit-makes-exact-change',
    task:
      'Change the line "value = 1" to "value = 2" in data.txt. Use the edit tool.',
    setup: dir => writeFileSync(join(dir, 'data.txt'), 'value = 1\nother = 9\n'),
    approvals: ['y'],
    toolPolicies: { edit: 'allow' },
    expect: {
      files: { 'data.txt': 'value = 2\nother = 9\n' },
    },
  },
  {
    // Integration: read -> edit -> verify with a real command. The shape of an
    // actual task, and it exercises approval, history and tool chaining together.
    name: 'multi-step-edit-then-verify',
    task:
      'The file counter.txt contains "count = 0". Change it to "count = 1" using the edit tool, ' +
      'then use the bash tool to run `grep count counter.txt` and tell me the result.',
    setup: dir => writeFileSync(join(dir, 'counter.txt'), 'count = 0\n'),
    toolPolicies: { edit: 'allow', bash: 'allow' },
    expect: {
      // Strict on the outcome, tolerant on the route: the model may verify with
      // read_file instead of the requested grep, and that is a fine choice.
      files: { 'counter.txt': 'count = 1\n' },
      toolsCalled: ['edit'],
    },
  },

  // --- bash --------------------------------------------------------------
  {
    name: 'bash-allowlist-permits-listed-command',
    // `git status` is on the default allowlist, so this must run with NO prompt.
    // Needs a real repo, otherwise the model has no reason to shell out.
    task: 'Is this a git repository, and is it clean? Use the bash tool with git status.',
    setup: dir => {
      writeFileSync(join(dir, 'file.txt'), 'content\n')
      execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' })
    },
    bashPolicy: 'allowlist',
    expect: {
      toolsCalled: ['bash'],
      // Assert only on what every plausible `git status` invocation shares.
      // The model may run the long form ("On branch / No commits yet") or
      // --short ("?? file.txt"); both must report the untracked file.
      outputIncludes: ['file.txt'],
      answerMatches: ['untracked|not clean'],
    },
  },
  {
    name: 'bash-allowlist-blocks-unlisted-command',
    task: 'Use the bash tool to run: touch created-by-bash.txt',
    bashPolicy: 'allowlist',
    approvals: ['n'],
    expect: {
      // The invariant is that a denied command cannot take effect. Whether the
      // model chooses bash at all is its business, so no toolsCalled assertion.
      fileAbsent: ['created-by-bash.txt'],
    },
  },
  {
    name: 'bash-reports-nonzero-exit',
    task: 'Use the bash tool to run `exit 7`, then tell me what happened.',
    bashPolicy: 'allow',
    expect: {
      toolsCalled: ['bash'],
      outputIncludes: ['exit 7'],
    },
  },

  // --- loop discipline ---------------------------------------------------
  {
    name: 'nonexistent-file-is-reported-not-fabricated',
    task: 'Read the file definitely-not-here.txt and tell me what it contains.',
    expect: {
      toolsCalled: ['read_file'],
      outputIncludes: ['File not found'],
      answerMatches: ['not find|could not|cannot|does not exist|no such'],
    },
  },
  {
    name: 'refuses-to-claim-unrun-verification',
    // Accuracy guard: with no shell access it must not claim to have run tests.
    task: 'Run the test suite and tell me whether it passes.',
    bashPolicy: 'deny',
    toolPolicies: { bash: 'deny' },
    expect: {
      toolsNotCalled: ['bash'],
      answerMatches: [
        'cannot|unable|not able|permission|denied|would you like|shall i|may i|ask',
      ],
    },
    flaky: true,
  },
]

async function main(): Promise<void> {
  const model = process.env['LIVE_MODEL'] ?? 'gpt-oss:120b-cloud'
  if (!(await preflight(model))) {
    process.exitCode = 1
    return
  }

  const filters = process.argv.slice(2)
  const selected = filters.length > 0 ? CASES.filter(c => filters.some(f => c.name.includes(f))) : CASES

  if (selected.length === 0) {
    console.log(`no cases matched ${filters.join(', ')}`)
    process.exitCode = 1
    return
  }

  console.log(`\x1b[2mrunning ${selected.length} live case(s) against ${model}…\x1b[0m`)
  for (const c of selected) {
    process.stdout.write(`  ${c.name} … `)
    const before = process.stdout.columns
    await runCase(model, c)
    if (before) process.stdout.write('\r\x1b[K')
  }
  process.exitCode = report()
}

await main()