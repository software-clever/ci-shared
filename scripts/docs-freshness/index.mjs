#!/usr/bin/env node
// docs-freshness: blocks the "code landed, roadmap forgotten" class of doc drift.
//
// The roadmap narrates state (phase status, "As built" commit SHAs, PR numbers)
// that actually lives in git and the code. Whenever code lands without the same
// change touching the roadmap, the prose rots. Two independent, deterministic
// checks close the part of that gap a machine can actually hold:
//
//   Check A (doc-coupling gate): a change that touches configured code paths but
//     no configured doc path fails, UNLESS the change is explicitly declared
//     docs-exempt via a `no-docs` label or a `Docs:` commit trailer. Pure
//     refactors are not blocked; they are declared. This forces an explicit
//     "did the roadmap move?" decision in the same change.
//
//   Check B (referential integrity): commit SHAs cited in the tracked docs that
//     do not resolve in git are surfaced. Catches references that rot. Roadmaps
//     here legitimately cite CROSS-REPO "As built" commits (e.g. a SHA in the
//     marketing-site repo) which cannot resolve in this clone, so unresolved
//     SHAs WARN by default and only fail when the repo opts into
//     `integrityStrict` (use that only where every cited SHA is same-repo).
//
// Honest limit: no gate can verify the prose is semantically CORRECT and current.
// This removes the "I forgot the doc exists" class of drift, which is the one
// that bit us; semantic correctness still rides on the author.
//
// Zero runtime deps. Reads ./docs-freshness.json from the repo root (cwd).
// See AI_OPERATING_MODEL.md (umbrella) for where this sits in the three-layer model.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Run git, return trimmed stdout, or null on non-zero exit. */
function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

/** Parse `--key value` and `--flag` CLI args into a plain object. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

/** Convert a single glob (supporting **, *, ?) into an anchored RegExp. */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?'; // **/ matches zero or more leading path segments
        } else {
          re += '.*'; // ** matches across separators
        }
      } else {
        re += '[^/]*'; // * matches within a single path segment
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\/'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function matchesAny(path, patterns) {
  return patterns.some((p) => globToRegExp(p).test(path));
}

function log(msg) {
  process.stdout.write(msg + '\n');
}

// ---------------------------------------------------------------------------
// Inputs: config + change context (CI event, CLI overrides, or local git)
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const advisory = Boolean(args.advisory); // warn-only: never fail the process
const check = (args.check || 'both').toLowerCase(); // a | b | both

const configPath = args.config || 'docs-freshness.json';
if (!existsSync(configPath)) {
  log(`docs-freshness: no ${configPath} found in this repo; nothing to check.`);
  process.exit(0);
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const codePaths = config.codePaths || [];
const codeExcludes = config.codeExcludes || [];
const docPaths = config.docPaths || [];
const integrityDocs = config.integrityDocs || [];
const integrityStrict = Boolean(config.integrityStrict); // unresolved SHA fails (else warns)
const roadmapHint = config.roadmapHint || (docPaths[0] || 'the docs');

/**
 * Resolve the base ref to diff against and the labels/trailers that grant a
 * docs-exemption. Precedence: explicit CLI overrides (for tests) > CI event
 * payload > local git defaults.
 */
function resolveContext() {
  // CLI overrides make the gate unit-testable without crafting real branches.
  if (args.changed !== undefined) {
    return {
      source: 'cli',
      changed: String(args.changed).split(',').map((s) => s.trim()).filter(Boolean),
      labels: String(args.labels || '').split(',').map((s) => s.trim()).filter(Boolean),
      trailers: String(args.trailers || ''),
    };
  }

  // GitHub Actions pull_request event: read the payload for base ref + labels.
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && existsSync(eventPath)) {
    try {
      const event = JSON.parse(readFileSync(eventPath, 'utf8'));
      const pr = event.pull_request;
      if (pr) {
        const baseRef = pr.base?.ref || process.env.GITHUB_BASE_REF;
        const labels = (pr.labels || []).map((l) => l.name);
        const base = `origin/${baseRef}`;
        const range = git(['merge-base', base, 'HEAD'], { allowFail: true }) || base;
        const changed = (git(['diff', '--name-only', `${range}...HEAD`], { allowFail: true }) || '')
          .split('\n').map((s) => s.trim()).filter(Boolean);
        const trailers = git(['log', `${range}..HEAD`, '--format=%B%x00'], { allowFail: true }) || '';
        return { source: 'github', changed, labels, trailers };
      }
    } catch {
      // fall through to local
    }
  }

  // Local / pre-commit: staged changes, no PR labels, current commit message only.
  const changed = (git(['diff', '--cached', '--name-only'], { allowFail: true }) || '')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  return { source: 'local', changed, labels: [], trailers: '' };
}

const ctx = resolveContext();

// ---------------------------------------------------------------------------
// Check A: doc-coupling gate
// ---------------------------------------------------------------------------

function isCode(path) {
  return matchesAny(path, codePaths) && !matchesAny(path, codeExcludes);
}
function isDoc(path) {
  return matchesAny(path, docPaths);
}

function hasDocsExemption() {
  const labelExempt = ctx.labels.map((l) => l.toLowerCase()).includes('no-docs');
  // A `Docs:` trailer on any commit in the range declares the docs decision.
  const trailerExempt = /^Docs:\s*\S/m.test(ctx.trailers || '');
  return { labelExempt, trailerExempt, exempt: labelExempt || trailerExempt };
}

function runCheckA() {
  const codeTouched = ctx.changed.filter(isCode);
  const docTouched = ctx.changed.filter(isDoc);

  if (codeTouched.length === 0) {
    log('docs-freshness [gate]: no watched code paths changed; gate not applicable.');
    return true;
  }
  if (docTouched.length > 0) {
    log(`docs-freshness [gate]: code + docs changed together (${docTouched.length} doc file(s)). OK.`);
    return true;
  }
  const ex = hasDocsExemption();
  if (ex.exempt) {
    const why = ex.labelExempt ? "`no-docs` label" : '`Docs:` commit trailer';
    log(`docs-freshness [gate]: ${codeTouched.length} code file(s) changed, no docs, but ${why} present. Declared exempt.`);
    return true;
  }

  // Violation.
  log('');
  log('docs-freshness [gate]: FAIL');
  log(`  ${codeTouched.length} watched code file(s) changed but no doc was updated:`);
  for (const f of codeTouched.slice(0, 10)) log(`    - ${f}`);
  if (codeTouched.length > 10) log(`    ... and ${codeTouched.length - 10} more`);
  log('');
  log(`  If this change altered shipped behaviour or advanced a phase, update ${roadmapHint}`);
  log('  in this same change. If it genuinely needs no doc update, declare it:');
  log('    - add a `no-docs` label to the PR, OR');
  log('    - add a commit trailer, e.g.  Docs: n/a (pure refactor, no behaviour change)');
  log('');
  return false;
}

// ---------------------------------------------------------------------------
// Check B: referential integrity of cited commit SHAs
// ---------------------------------------------------------------------------

function runCheckB() {
  const unresolved = [];
  const seen = new Set();
  for (const docFile of integrityDocs) {
    if (!existsSync(docFile)) continue;
    const text = readFileSync(docFile, 'utf8');
    // Backtick-wrapped, 7-40 hex chars, containing at least one a-f letter so we
    // don't flag pure-decimal tokens (dates, counts) that look hex-ish.
    const matches = text.matchAll(/`([0-9a-f]{7,40})`/g);
    for (const m of matches) {
      const sha = m[1];
      if (!/[a-f]/.test(sha)) continue;
      const key = `${docFile}:${sha}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const resolved = git(['cat-file', '-e', `${sha}^{commit}`], { allowFail: true });
      if (resolved === null) unresolved.push({ docFile, sha });
    }
  }
  if (unresolved.length === 0) {
    log('docs-freshness [integrity]: all cited commit SHAs resolve. OK.');
    return true;
  }
  const level = integrityStrict ? 'FAIL' : 'WARN';
  for (const { docFile, sha } of unresolved) {
    log(`docs-freshness [integrity] ${level}: ${docFile} cites commit \`${sha}\` which does not resolve in this repo.`);
  }
  if (!integrityStrict) {
    log('docs-freshness [integrity]: these may be legitimate cross-repo citations; eyeball them, not blocking.');
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

let pass = true;
if (check === 'a' || check === 'both') pass = runCheckA() && pass;
if (check === 'b' || check === 'both') pass = runCheckB() && pass;

if (!pass && advisory) {
  log('docs-freshness: violations above (advisory mode — not blocking this commit).');
  process.exit(0);
}
process.exit(pass ? 0 : 1);
