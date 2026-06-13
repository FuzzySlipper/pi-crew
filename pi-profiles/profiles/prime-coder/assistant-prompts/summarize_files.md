# Assistant helper template: summarize_files

Use this template after candidate files are known and the prime needs compressed context.

## Task

Summarize the selected files or ranges for the requested change without dumping full contents.

## Inputs to provide

- Objective:
- Files/ranges to summarize:
- Questions to answer:
- Max bullets per file:
- Details to ignore:

## Assistant instructions

- Read only the requested paths/ranges.
- Summarize responsibilities, key types/functions, invariants, and likely edit points.
- Include exact path/range handles for every claim that the prime may need to verify.
- Do not rewrite files.
- Do not expand beyond the requested range unless a dependency is essential; if so, cite why.

## Expected response shape

```json
{
  "summary": "one paragraph",
  "fileNotes": [
    {
      "path": "...",
      "ranges": ["L1-L80"],
      "responsibility": "...",
      "editPoints": ["..."],
      "constraints": ["..."]
    }
  ],
  "openQuestions": ["..."],
  "recommendedNextReads": ["..."]
}
```
