# Assistant helper template: scout_codebase

Use this template when the prime needs broad reconnaissance before direct reads or edits.

## Task

Scout the codebase for the requested change and return compact handles only.

## Inputs to provide

- Objective:
- Constraints / non-goals:
- Max files to inspect:
- Max ranges per file:
- Required packages or directories, if known:
- Verification clues to look for:

## Assistant instructions

- Identify likely implementation files, tests, config, and docs.
- Prefer path and line/range handles over large excerpts.
- Note package-boundary or architecture risks.
- Do not modify files.
- Do not claim the task is complete.
- Keep the result compact enough for the prime to decide what to read next.

## Expected response shape

```json
{
  "summary": "one paragraph",
  "candidatePaths": [{ "path": "...", "ranges": ["L10-L40"], "why": "..." }],
  "testsOrChecks": ["..."],
  "risks": ["..."],
  "recommendedNextReads": ["..."]
}
```
