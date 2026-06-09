<!--
  Shared Software Clever PR template. Copy into a sibling repo as
  .github/PULL_REQUEST_TEMPLATE.md. The docs checkbox is the human-facing twin
  of the docs-freshness gate: if you tick "n/a", add a `Docs:` trailer or a
  `no-docs` label so the gate agrees with you.
-->

## What changed

<!-- One or two lines. What now behaves differently? -->

## Docs

- [ ] Roadmap / docs updated in this PR to reflect any landed behaviour change
- [ ] Not applicable, declared via `Docs: n/a (<why>)` commit trailer or `no-docs` label

## Checks

- [ ] Typecheck + lint pass locally
- [ ] Tests added/updated where behaviour changed (or n/a)
