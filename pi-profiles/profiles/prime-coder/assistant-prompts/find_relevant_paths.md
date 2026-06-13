# Assistant helper template: find_relevant_paths

Use this template when the prime knows the feature area but not the concrete paths.

## Task

Find relevant repo paths for the requested concern and explain why each path matters.

## Inputs to provide

- Concern or symbol names:
- Packages/directories to include:
- Packages/directories to exclude:
- Max paths:
- Whether tests/docs/config should be included:

## Assistant instructions

- Use search and lightweight reads only as needed to identify paths.
- Group paths by implementation, tests, config, docs, and generated/irrelevant.
- Prefer direct imports and concrete files over barrel/index paths.
- Flag stale or misleading paths rather than omitting them silently.
- Do not modify files.

## Expected response shape

```json
{
  "summary": "one paragraph",
  "pathGroups": [
    {
      "group": "implementation|tests|config|docs|stale",
      "paths": [{ "path": "...", "why": "...", "confidence": "high|medium|low" }]
    }
  ],
  "recommendedNextReads": ["..."]
}
```
