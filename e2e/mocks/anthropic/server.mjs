#!/usr/bin/env node
// Mock Anthropic Messages API for the local stack and e2e (W8-A). It stands in for
// https://api.anthropic.com/v1/messages, so no stack test calls Claude for question moderation
// (apps/api/src/moderation/claude.ts). The answer is the rubric's structured JSON, chosen by markers
// anywhere in the user message (the question's prompt, labels or emojis):
//   [refuse]     stop_reason "refusal" with stop_details, no content (moderation: review)
//   [error]      HTTP 500 api_error; the SDK retries once, then gives up (moderation: review)
//   [unsafe]     safe false, with a reason
//   [onesided]   twoSided false, with a reason
//   [factual]    preferenceBased false, with a reason
//   [split=0.8]  predictedSplit 0.8 (default 0.6; a bad value such as 0.3 tests invalid output)
//   [badjson]    text that is not JSON (moderation: review, invalid_output)
// Anything else passes every check. Markers combine.
//
//   node e2e/mocks/anthropic/server.mjs            # listens on 127.0.0.1:8793
//   MOCK_ANTHROPIC_PORT=9002 node e2e/mocks/anthropic/server.mjs
//
// Point the API at it in `.dev.vars` (the origin override is honoured only when ENVIRONMENT=local):
//   ANTHROPIC_BASE_URL=http://127.0.0.1:8793
//   ANTHROPIC_API_KEY=mock-anthropic-key
//
// Endpoints besides the Messages API:
//   GET /calls   {"count": n, "last": <the last request body or null>}
//   GET /health  {"ok": true}
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const port = Number(process.env.MOCK_ANTHROPIC_PORT ?? 8793);
const host = process.env.MOCK_ANTHROPIC_HOST ?? '127.0.0.1';
const origin = `http://${host}:${port}`;

let calls = 0;
let last = null;

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'request-id': `req_mock_${calls}` });
  res.end(JSON.stringify(body));
}

function apiError(res, status, type, message) {
  return json(res, status, { type: 'error', error: { type, message } });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/** The user message's text (a string or text blocks). */
function userText(body) {
  const user = (body.messages ?? []).filter((m) => m.role === 'user');
  return user
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : (m.content ?? [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n'),
    )
    .join('\n');
}

/** The rubric's output for this user text. */
export function moderationOutput(text) {
  const split = /\[split=([0-9.]+)\]/.exec(text);
  const out = {
    safe: !text.includes('[unsafe]'),
    twoSided: !text.includes('[onesided]'),
    preferenceBased: !text.includes('[factual]'),
    predictedSplit: split ? Number(split[1]) : 0.6,
    reason: '',
  };
  if (!out.safe) out.reason = "Mock: this question isn't allowed.";
  else if (!out.twoSided) out.reason = 'Mock: one option is the obvious pick.';
  else if (!out.preferenceBased) out.reason = 'Mock: this has a correct answer.';
  return out;
}

function message(body, { content, stopReason, stopDetails = null }) {
  return {
    id: `msg_mock_${randomUUID().replaceAll('-', '')}`,
    type: 'message',
    role: 'assistant',
    model: body.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: stopDetails,
    usage: {
      input_tokens: 40,
      output_tokens: 30,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

async function messages(req, res) {
  if (!req.headers['x-api-key']) {
    return apiError(res, 401, 'authentication_error', 'x-api-key header is required');
  }
  let body;
  try {
    body = await readJson(req);
  } catch {
    return apiError(res, 400, 'invalid_request_error', 'body is not JSON');
  }
  last = body;
  if (!body.model || !body.max_tokens || !Array.isArray(body.messages)) {
    return apiError(
      res,
      400,
      'invalid_request_error',
      'model, max_tokens and messages are required',
    );
  }
  if (body.output_config?.format?.type !== 'json_schema') {
    return apiError(res, 400, 'invalid_request_error', 'mock: output_config.format is required');
  }
  const text = userText(body);
  if (text.includes('[error]')) return apiError(res, 500, 'api_error', 'mock: internal error');
  if (text.includes('[refuse]')) {
    return json(
      res,
      200,
      message(body, {
        content: [],
        stopReason: 'refusal',
        stopDetails: { type: 'refusal', category: 'general_harms', explanation: null },
      }),
    );
  }
  const out = text.includes('[badjson]') ? 'not json' : JSON.stringify(moderationOutput(text));
  return json(
    res,
    200,
    message(body, { content: [{ type: 'text', text: out }], stopReason: 'end_turn' }),
  );
}

const server = createServer((req, res) => {
  const route = `${req.method} ${new URL(req.url ?? '/', origin).pathname}`;
  if (route === 'GET /health') return json(res, 200, { ok: true });
  if (route === 'GET /calls') return json(res, 200, { count: calls, last });
  if (route === 'POST /v1/messages') {
    calls += 1;
    messages(req, res).catch(() => apiError(res, 500, 'api_error', 'mock: unexpected error'));
    return undefined;
  }
  return apiError(res, 404, 'not_found_error', 'not found');
});

server.listen(port, host, () => {
  console.log(`mock Anthropic Messages API on ${origin}`);
});
