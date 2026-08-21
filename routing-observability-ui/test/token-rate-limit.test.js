import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const cwd = new URL('..', import.meta.url).pathname;
const children = [];
const upstreams = [];

async function startUpstream(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  upstreams.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

async function start(env) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', "import('./server.js').then(({ server }) => console.log(`READY:${server.address().port}`))"], {
    cwd,
    env: { ...process.env, PORT: '0', JAEGER_URL: 'http://localhost:19999', ALLOW_SIMULATION: 'false', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 5000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/READY:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`server exited with ${code}: ${output}`)));
  });
  return `http://127.0.0.1:${port}`;
}

after(() => {
  children.forEach(child => child.kill());
  upstreams.forEach(server => server.close());
});

describe('token-rate-limit feature gate', () => {
  it('does not expose quota data by default', async () => {
    const base = await start({ TRACING_UI_TOKEN_RATE_LIMIT: 'false' });
    const capabilities = await (await fetch(`${base}/api/v1/capabilities`)).json();
    const quota = await (await fetch(`${base}/api/v1/token-rate-limit`)).json();
    assert.equal(capabilities.features.tokenRateLimit, false);
    assert.equal(quota.enabled, false);
    assert.equal(quota.data, null);
  });

  it('enables the normalized synthetic contract only with both flags', async () => {
    const base = await start({ TRACING_UI_TOKEN_RATE_LIMIT: 'true', TRACING_UI_FIXTURE_MODE: 'token-rate-limit' });
    const capabilities = await (await fetch(`${base}/api/v1/capabilities`)).json();
    const quota = await (await fetch(`${base}/api/v1/token-rate-limit?state=exhausted`)).json();
    assert.equal(capabilities.features.tokenRateLimit, true);
    assert.equal(capabilities.features.fixtureMode, 'token-rate-limit');
    assert.equal(quota.data.principal, 'alice');
    assert.equal(quota.data.quota.shared_key, 'alice/canonical-model');
    assert.equal(quota.data.policy.algorithm, 'sliding_window');
    assert.equal(quota.data.policy.accounting, 'total_tokens');
    assert.equal(quota.data.policy.unsupported_algorithms.token_bucket, 'Not implemented');
    const denied = quota.data.requests.find(item => item.admission === 'denied');
    assert.equal(denied.http.status, 429);
    assert.equal(denied.route.provider_gateway, null);
    assert.deepEqual(denied.route.hops, ['consumer-gateway', 'quota-admission']);
  });

  it('selects the dedicated token-rate-limit profile and locks the source', async () => {
    const base = await start({
      TRACING_UI_PROFILE: 'token-rate-limit',
      TRACING_UI_TOKEN_RATE_LIMIT: 'true',
      TRACING_UI_TOKEN_CONSUMER_A_URL: 'http://127.0.0.1:1',
      TRACING_UI_TOKEN_CONSUMER_B_URL: 'http://127.0.0.1:1',
      TRACING_UI_TOKEN_PASSWORD: 'test-password',
    });
    const capabilities = await (await fetch(`${base}/api/v1/capabilities`)).json();
    assert.equal(capabilities.environment.profile, 'token_rate_limit');
    const sources = await (await fetch(`${base}/api/source`)).json();
    assert.equal(sources.source, 'vcr');
    assert.equal(sources.available.glb, false);
    const switched = await fetch(`${base}/api/source`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'glb' }),
    });
    assert.equal(switched.status, 409);
  });

  it('enables the panel without fabricating data when fixture mode is absent', async () => {
    const base = await start({ TRACING_UI_TOKEN_RATE_LIMIT: 'true' });
    const quota = await (await fetch(`${base}/api/v1/token-rate-limit`)).json();
    assert.equal(quota.enabled, true);
    assert.equal(quota.data, null);
    assert.match(quota.warning, /live consumer URLs and server-side credentials/);
  });

  it('records bounded live requests without exposing credentials or mutating quota on clear', async () => {
    let calls = 0;
    const authorizations = [];
    const upstream = await startUpstream((req, res) => {
      authorizations.push(req.headers.authorization);
      calls += 1;
      req.resume();
      if (calls === 1) {
        res.writeHead(200, { 'content-type': 'application/json', 'x-ai-demo-provider-gateway': 'west' });
        res.end(JSON.stringify({ usage: { total_tokens: 15 } }));
      } else {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': '60',
          'x-ratelimit-limit': '60',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '60',
        });
        res.end(JSON.stringify({ error: 'quota exhausted' }));
      }
    });
    const base = await start({
      TRACING_UI_TOKEN_RATE_LIMIT: 'true',
      TRACING_UI_TOKEN_CONSUMER_A_URL: upstream,
      TRACING_UI_TOKEN_CONSUMER_B_URL: upstream,
      TRACING_UI_TOKEN_PASSWORD: 'test-password',
    });
    const capabilities = await (await fetch(`${base}/api/v1/capabilities`)).json();
    assert.equal(capabilities.features.tokenRateLimitLive, true);

    const admitted = await (await fetch(`${base}/api/v1/token-rate-limit/requests`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consumer: 'a' }),
    })).json();
    assert.equal(admitted.record.http.status, 200);
    assert.equal(admitted.record.route.provider_gateway, 'west');
    assert.equal(admitted.record.quota.actual_tokens, 15);

    const denied = await (await fetch(`${base}/api/v1/token-rate-limit/requests`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consumer: 'b' }),
    })).json();
    assert.equal(denied.record.http.status, 429);
    assert.equal(denied.record.route.provider_gateway, null);
    assert.equal(denied.record.quota.remaining, 0);
    assert.deepEqual(denied.record.route.hops, ['client', 'consumer-gateway-b', 'quota-denied']);
    assert.equal(authorizations.length, 2);
    assert.ok(authorizations.every(value => value?.startsWith('Basic ')));
    assert.doesNotMatch(JSON.stringify(denied), /test-password/);

    const cleared = await (await fetch(`${base}/api/v1/token-rate-limit/requests`, { method: 'DELETE' })).json();
    assert.equal(cleared.data.requests.length, 0);
    assert.equal(calls, 2, 'clearing display history must not contact or mutate the upstream quota path');
  });
});
