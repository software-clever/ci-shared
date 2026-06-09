# ci-shared

Shared CI mechanisms for Software Clever sibling repos, maintained once and
inherited rather than re-implemented per repo. This is the home named in the
umbrella [`AI_OPERATING_MODEL.md`](../../AI_OPERATING_MODEL.md) Phase 3 (shared
umbrella ruleset).

## docs-freshness

Blocks the "code landed, roadmap forgotten" class of documentation drift. Two
deterministic checks (see [`scripts/docs-freshness/index.mjs`](scripts/docs-freshness/index.mjs)):

- **Check A, doc-coupling gate.** A change touching configured `codePaths` but no
  `docPaths` fails, unless declared docs-exempt by a `no-docs` PR label or a
  `Docs:` commit trailer. Forces an explicit "did the roadmap move?" decision in
  the same change.
- **Check B, referential integrity.** Commit SHAs cited in tracked docs that do
  not resolve in git are surfaced. Roadmaps here legitimately cite cross-repo
  "As built" commits (e.g. a marketing-site SHA), so unresolved SHAs **warn** by
  default; set `"integrityStrict": true` to make them block, only in repos where
  every cited SHA is same-repo.

It cannot verify that prose is semantically correct, only that the doc decision
was made and that references have not rotted. That is the part a machine can hold.

### Use it in a sibling repo

1. Add a `docs-freshness.json` at the repo root:

   ```json
   {
     "codePaths": ["core/**", "web/apps/**", "scripts/deploy*"],
     "codeExcludes": ["**/*.test.ts", "**/*.spec.ts", "**/*.md"],
     "docPaths": ["docs/**/*.md", "CLAUDE.md"],
     "integrityDocs": ["docs/ROADMAP.md"],
     "roadmapHint": "docs/ROADMAP.md"
   }
   ```

2. Add a job to the repo's CI:

   ```yaml
   jobs:
     docs-freshness:
       uses: software-clever/ci-shared/.github/workflows/docs-freshness.yml@main
   ```

3. Optional Layer 2 (advisory) in `.husky/pre-commit`:

   ```sh
   node ../ci-shared/scripts/docs-freshness/index.mjs --advisory || true
   ```

   (Or vendor the script. Pre-commit is advisory; CI is the blocking backstop.)

4. Copy [`templates/PULL_REQUEST_TEMPLATE.md`](templates/PULL_REQUEST_TEMPLATE.md)
   to `.github/PULL_REQUEST_TEMPLATE.md`.

### Run it locally

```sh
# Against staged changes (advisory):
node scripts/docs-freshness/index.mjs --advisory

# Test the gate with an explicit change set (no real branch needed):
node scripts/docs-freshness/index.mjs --check a --changed "core/apps/api/src/foo.ts"
node scripts/docs-freshness/index.mjs --check a --changed "core/apps/api/src/foo.ts" --trailers "Docs: n/a"
```
