# Mock Anthropic Messages API

A stand-in for `https://api.anthropic.com/v1/messages` in the local stack (W8-A), so no stack test or
Playwright spec calls Claude when a question is moderated (`apps/api/src/moderation/claude.ts`). It answers
with the rubric's structured JSON, chosen by markers in the question (prompt, labels or emojis):

| Marker        | Answer                                                     | Moderation                  |
| ------------- | ---------------------------------------------------------- | --------------------------- |
| (none)        | every check passes, `predictedSplit` 0.6                   | pass                        |
| `[unsafe]`    | `safe: false` with a reason                                | reject                      |
| `[onesided]`  | `twoSided: false` with a reason                            | reject                      |
| `[factual]`   | `preferenceBased: false` with a reason                     | reject                      |
| `[split=0.8]` | that `predictedSplit` (0.3 or 1.2 test invalid output)     | pass (or review if invalid) |
| `[badjson]`   | text that is not JSON                                      | review (`invalid_output`)   |
| `[refuse]`    | `stop_reason: "refusal"` with `stop_details`, no content   | review (`refusal`)          |
| `[error]`     | HTTP 500 `api_error` (the SDK retries once, then gives up) | review (`model_error`)      |

```bash
node e2e/mocks/anthropic/server.mjs   # http://127.0.0.1:8793, MOCK_ANTHROPIC_PORT to change
```

The stack's port variable is `STACK_ANTHROPIC_PORT` (default 8793). Point the API at the mock in
`.dev.vars`; the API honours `ANTHROPIC_BASE_URL` only when `ENVIRONMENT=local`, so staging and production
always call `api.anthropic.com`. The key must be set (any value; the mock only checks that `x-api-key` is
present), or moderation sends every question to review:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8793
ANTHROPIC_API_KEY=mock-anthropic-key
```

`GET /calls` returns `{"count": n, "last": <last request body>}`, so a test can check the stack used the mock
and what it sent. Duplicate detection does not use this server: locally the API compares normalized question
text in D1 (`apps/api/src/moderation/duplicates.ts`).
