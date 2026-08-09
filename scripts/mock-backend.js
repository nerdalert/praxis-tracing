#!/usr/bin/env node
// Mock AI backend for the real Praxis tracing harness.
//
// Returns a fixed OpenAI-compatible response and logs received
// traceparent headers for verification. Does not record request
// bodies, prompts, credentials, or sensitive data.
//
// Usage:
//   node mock-backend.js [port] [pool-name]

import http from 'http';

const PORT = parseInt(process.argv[2] || '9100', 10);
const POOL = process.argv[3] || 'pool-a';

const RESPONSE = JSON.stringify({
  id: 'chatcmpl-mock',
  object: 'chat.completion',
  model: 'test-model',
  choices: [{
    index: 0,
    message: { role: 'assistant', content: `Hello from ${POOL}` },
    finish_reason: 'stop',
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const server = http.createServer((req, res) => {
  const traceparent = req.headers['traceparent'] || 'none';
  const tracestate = req.headers['tracestate'] || 'none';
  const routingCandidate = req.headers['x-ai-routing-candidate'] || 'none';
  const routingRequestId = req.headers['x-ai-routing-request-id'] || 'none';

  // Log safe headers only — no body, no auth
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    pool: POOL,
    method: req.method,
    path: req.url,
    traceparent,
    tracestate,
    routing_candidate: routingCandidate,
    routing_request_id: routingRequestId,
  }));

  // Consume request body without recording it
  let bodySize = 0;
  req.on('data', chunk => { bodySize += chunk.length; });
  req.on('end', () => {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'x-mock-pool': POOL,
    });
    res.end(RESPONSE);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(JSON.stringify({
    event: 'started',
    pool: POOL,
    port: PORT,
    address: `127.0.0.1:${PORT}`,
  }));
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); process.exit(0); });
