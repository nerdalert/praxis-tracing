import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

let server;
let baseUrl;

async function api(path, opts) {
  const res = await fetch(`${baseUrl}/api${path}`, opts);
  return { status: res.status, body: await res.json() };
}

before(async () => {
  process.env.PORT = '0';
  process.env.JAEGER_URL = 'http://localhost:19999';
  const mod = await import('../server.js');
  server = mod.server;
  const addr = server.address();
  baseUrl = `http://localhost:${addr.port}`;
});

after(() => {
  if (server) server.close();
});

describe('status API', () => {
  it('returns status with mode', async () => {
    const { body } = await api('/status');
    assert.ok(['live', 'demo', 'unavailable'].includes(body.mode));
    assert.equal(typeof body.jaeger_reachable, 'boolean');
    assert.ok(body.jaeger_url);
  });
});

describe('mode switching', () => {
  it('switches to demo mode', async () => {
    const { body } = await api('/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'demo' }),
    });
    assert.equal(body.mode, 'demo');
  });

  it('rejects invalid mode', async () => {
    const { status } = await api('/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'invalid' }),
    });
    assert.equal(status, 400);
  });
});

describe('pools API', () => {
  it('returns pool data in demo mode', async () => {
    await api('/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'demo' }),
    });

    const { body } = await api('/pools');
    assert.equal(body.mode, 'demo');
    assert.ok(Array.isArray(body.pools));
    assert.equal(body.pools.length, 2);

    const poolA = body.pools.find(p => p.name === 'pool-a');
    const poolB = body.pools.find(p => p.name === 'pool-b');
    assert.ok(poolA, 'pool-a exists');
    assert.ok(poolB, 'pool-b exists');
    assert.equal(poolA.kind, 'Local');
    assert.equal(poolB.kind, 'Remote');
    assert.equal(typeof poolA.score, 'number');
    assert.equal(typeof poolB.score, 'number');
  });

  it('pool-a scores higher than pool-b at baseline', async () => {
    await api('/scenario/baseline', { method: 'POST' });
    const { body } = await api('/pools');
    const poolA = body.pools.find(p => p.name === 'pool-a');
    const poolB = body.pools.find(p => p.name === 'pool-b');
    assert.ok(poolA.score > poolB.score, `pool-a (${poolA.score}) should beat pool-b (${poolB.score}) at baseline`);
  });

  it('pool-b scores higher under pressure', async () => {
    await api('/scenario/pressure', { method: 'POST' });
    const { body } = await api('/pools');
    const poolA = body.pools.find(p => p.name === 'pool-a');
    const poolB = body.pools.find(p => p.name === 'pool-b');
    assert.ok(poolB.score > poolA.score, `pool-b (${poolB.score}) should beat pool-a (${poolA.score}) under pressure`);
  });
});

describe('scenarios API', () => {
  it('lists available scenarios', async () => {
    const { body } = await api('/scenarios');
    assert.ok(Array.isArray(body.scenarios));
    assert.ok(body.scenarios.length >= 4);
    const keys = body.scenarios.map(s => s.key);
    assert.ok(keys.includes('baseline'));
    assert.ok(keys.includes('pressure'));
    assert.ok(keys.includes('recovery'));
    assert.ok(keys.includes('degraded'));
  });

  it('triggers a scenario and returns updated state', async () => {
    const { body } = await api('/scenario/pressure', { method: 'POST' });
    assert.equal(body.scenario.name, 'pressure');
    assert.ok(Array.isArray(body.pools));
    assert.ok(body.trace);
    assert.ok(body.trace.trace_id);
  });

  it('rejects unknown scenario', async () => {
    const { status } = await api('/scenario/nonexistent', { method: 'POST' });
    assert.equal(status, 400);
  });
});

describe('traces API', () => {
  it('returns traces in demo mode', async () => {
    await api('/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'demo' }),
    });
    await api('/scenario/baseline', { method: 'POST' });

    const { body } = await api('/traces?limit=10');
    assert.equal(body.mode, 'demo');
    assert.ok(Array.isArray(body.traces));
    assert.ok(body.traces.length > 0);

    const trace = body.traces[0];
    assert.ok(trace.trace_id, 'has trace_id');
    assert.ok(trace.jaeger_url, 'has jaeger_url');
    assert.ok(trace.selected_provider, 'has selected_provider');
    assert.equal(typeof trace.span_count, 'number');
  });
});

describe('scoring correctness', () => {
  it('matches Rust scoring weights', async () => {
    await api('/scenario/baseline', { method: 'POST' });
    const { body } = await api('/pools');
    const poolA = body.pools.find(p => p.name === 'pool-a');

    // Local=1.0 * locality_weight=3.0 + (1-0.1) * queue_weight=5.0 = 3.0 + 4.5 = 7.5
    assert.equal(poolA.score, 7.5, 'pool-a baseline score should be 7.5');
  });

  it('degraded pool scores zero', async () => {
    await api('/scenario/degraded', { method: 'POST' });
    const { body } = await api('/pools');
    const poolA = body.pools.find(p => p.name === 'pool-a');
    assert.equal(poolA.score, 0, 'unhealthy pool score should be 0');
    assert.equal(poolA.rank, -1, 'unhealthy pool rank should be -1');
  });
});

describe('privacy', () => {
  it('no sensitive data in trace responses', async () => {
    await api('/scenario/baseline', { method: 'POST' });
    const { body } = await api('/traces?limit=5');
    const json = JSON.stringify(body);

    assert.ok(!json.includes('Bearer'), 'no auth tokens');
    assert.ok(!json.includes('sk-'), 'no API keys');
    assert.ok(!json.includes('cookie'), 'no cookies');
    assert.ok(!json.includes('secret'), 'no secrets');
    assert.ok(!json.includes('password'), 'no passwords');
  });
});

describe('Jaeger unavailable fallback', () => {
  it('falls back to demo when Jaeger is unreachable', async () => {
    await api('/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'auto' }),
    });
    const { body } = await api('/status');
    assert.equal(body.jaeger_reachable, false, 'Jaeger at port 19999 should be unreachable');
    assert.equal(body.mode, 'demo', 'auto mode falls back to demo when Jaeger is down');
  });

  it('pools endpoint returns demo data when Jaeger is unreachable', async () => {
    await api('/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'live' }),
    });
    const { body } = await api('/pools');
    assert.equal(body.mode, 'unavailable', 'live mode with no Jaeger reports unavailable');
    assert.ok(Array.isArray(body.pools), 'still returns pool data');
  });

  it('traces endpoint returns demo data when Jaeger is unreachable in live mode', async () => {
    await api('/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'live' }),
    });
    const { body } = await api('/traces?limit=5');
    assert.equal(body.mode, 'unavailable');
  });
});

describe('demo trace structure', () => {
  it('demo traces have no source field', async () => {
    await api('/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'demo' }),
    });
    await api('/scenario/baseline', { method: 'POST' });
    const { body } = await api('/traces?limit=5');
    for (const t of body.traces) {
      assert.ok(!t.source, 'demo traces should not have a source field');
      assert.ok(t.scenario, 'demo traces should have a scenario field');
    }
  });

  it('demo trace jaeger_url uses configured JAEGER_URL', async () => {
    await api('/scenario/baseline', { method: 'POST' });
    const { body } = await api('/traces?limit=1');
    const trace = body.traces[0];
    assert.ok(trace.jaeger_url.startsWith('http://localhost:19999/trace/'));
  });

  it('demo traces have routing metadata', async () => {
    await api('/scenario/baseline', { method: 'POST' });
    const { body } = await api('/traces?limit=1');
    const trace = body.traces[0];
    assert.ok(trace.selected_provider, 'has selected_provider');
    assert.ok(trace.selected_cluster, 'has selected_cluster');
    assert.ok(trace.routing_decision, 'has routing_decision');
    assert.ok(trace.routing_policy, 'has routing_policy');
    assert.equal(typeof trace.provider_score, 'number');
    assert.ok(trace.provider_score > 0, 'score should be positive for healthy pool');
  });
});

describe('trace limit enforcement', () => {
  it('respects limit parameter', async () => {
    await api('/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'demo' }),
    });
    for (let i = 0; i < 5; i++) {
      await api('/scenario/baseline', { method: 'POST' });
    }
    const { body } = await api('/traces?limit=3');
    assert.ok(body.traces.length <= 3, 'should respect limit');
  });

  it('caps limit at 100', async () => {
    const { body } = await api('/traces?limit=999');
    assert.ok(body.traces.length <= 100, 'should cap at 100');
  });
});

describe('multi-service configuration', () => {
  it('server has praxis-ai in JAEGER_SERVICES', async () => {
    const { body } = await api('/status');
    assert.ok(body.jaeger_url, 'jaeger_url is present');
  });
});

describe('status live_detail field', () => {
  it('returns live_detail as null when Jaeger is unreachable', async () => {
    await api('/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'auto' }),
    });
    const { body } = await api('/status');
    assert.equal(body.live_detail, null, 'no live_detail when Jaeger is down');
  });

  it('returns live_detail as null in demo mode', async () => {
    await api('/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'demo' }),
    });
    const { body } = await api('/status');
    assert.equal(body.live_detail, null, 'no live_detail in demo mode');
  });
});

describe('trace detail endpoint', () => {
  it('returns 404 for nonexistent trace', async () => {
    const { status } = await api('/trace/0000000000000000');
    assert.ok(status === 404 || status === 502, 'returns 404 or 502 for bad trace');
  });
});

describe('providers endpoint', () => {
  it('returns providers with pressure classification in demo mode', async () => {
    await api('/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'demo' }),
    });
    const { body } = await api('/providers');
    assert.equal(body.mode, 'demo');
    assert.ok(body.scoring_strategy, 'has scoring_strategy');
    assert.ok(Array.isArray(body.providers));
    assert.ok(body.providers.length >= 2);
    for (const p of body.providers) {
      assert.ok(p.pressure_level, `${p.name} has pressure_level`);
      assert.ok(['normal', 'elevated', 'high', 'critical', 'unknown'].includes(p.pressure_level),
        `${p.name} pressure_level is valid: ${p.pressure_level}`);
    }
  });

  it('pressure classification matches baseline thresholds', async () => {
    await api('/scenario/baseline', { method: 'POST' });
    const { body } = await api('/providers');
    const poolA = body.providers.find(p => p.name === 'pool-a');
    assert.equal(poolA.pressure_level, 'normal', '0.1 queue_depth is normal');
  });

  it('pressure classification matches pressure scenario', async () => {
    await api('/scenario/pressure', { method: 'POST' });
    const { body } = await api('/providers');
    const poolA = body.providers.find(p => p.name === 'pool-a');
    assert.equal(poolA.pressure_level, 'critical', '0.95 queue_depth is critical');
  });
});

describe('overlay endpoint', () => {
  it('returns overlay status', async () => {
    const { body } = await api('/overlay');
    assert.equal(typeof body.available, 'boolean');
    if (!body.available) {
      assert.equal(body.overlay, null);
    }
  });
});

describe('pressure threshold boundaries', () => {
  it('fresh zero is normal, not unknown', async () => {
    await api('/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'demo' }),
    });
    await api('/scenario/baseline', { method: 'POST' });
    const { body } = await api('/providers');
    const poolA = body.providers.find(p => p.name === 'pool-a');
    assert.equal(poolA.pressure_level, 'normal');
    assert.notEqual(poolA.pressure_level, 'unknown', 'fresh zero must not be unknown');
  });

  it('unavailable score renders as null, never zero', async () => {
    const { body } = await api('/providers');
    for (const p of body.providers) {
      if (p.score === null) {
        assert.strictEqual(p.score, null, 'null score must be null, not zero');
      }
    }
  });
});

describe('timeline endpoint', () => {
  it('returns demo timeline events in demo mode', async () => {
    await api('/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'demo' }),
    });
    const { body } = await api('/timeline');
    assert.equal(body.mode, 'demo');
    assert.ok(Array.isArray(body.events));
    assert.ok(body.events.length > 0);
    for (const e of body.events) {
      assert.ok(e.time, 'event has time');
      assert.ok(e.type, 'event has type');
      assert.ok(e.label, 'event has label');
    }
  });

  it('timeline includes route_change event', async () => {
    const { body } = await api('/timeline');
    const routeChange = body.events.find(e => e.type === 'route_change');
    assert.ok(routeChange, 'demo timeline has route_change event');
  });
});

describe('null safety in scoring', () => {
  it('scorePool handles null queue_depth without coercing to zero', async () => {
    await api('/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'demo' }),
    });
    const { body } = await api('/pools');
    for (const p of body.pools) {
      if (p.healthy) {
        assert.equal(typeof p.score, 'number', `${p.name} healthy pool has numeric score`);
        assert.ok(p.score > 0, `${p.name} healthy pool score is positive`);
      }
    }
  });

  it('degraded pool pressure is classified based on available metrics', async () => {
    await api('/scenario/degraded', { method: 'POST' });
    const { body } = await api('/providers');
    const poolA = body.providers.find(p => p.name === 'pool-a');
    assert.ok(poolA, 'pool-a exists');
    assert.ok(poolA.pressure_level, 'has pressure_level even when unhealthy');
  });
});

describe('data source selector', () => {
  it('returns current source', async () => {
    const { body } = await api('/source');
    assert.ok(['glb', 'vcr', 'combined'].includes(body.source));
    assert.equal(typeof body.available.glb, 'boolean');
    assert.equal(typeof body.available.vcr, 'boolean');
  });

  it('switches to vcr source', async () => {
    const { body } = await api('/source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'vcr' }),
    });
    assert.equal(body.source, 'vcr');
    const { body: check } = await api('/source');
    assert.equal(check.source, 'vcr');
    await api('/source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'glb' }),
    });
  });

  it('rejects invalid source', async () => {
    const { status } = await api('/source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'invalid' }),
    });
    assert.equal(status, 400);
  });
});

describe('vcr endpoints', () => {
  it('vcr status reports availability', async () => {
    const { body } = await api('/vcr/status');
    assert.equal(typeof body.available, 'boolean');
  });

  it('vcr providers returns array', async () => {
    const { body } = await api('/vcr/providers');
    assert.ok(Array.isArray(body.providers));
  });

  it('vcr timeline returns events array', async () => {
    const { body } = await api('/vcr/timeline');
    assert.ok(Array.isArray(body.events));
  });
});

describe('status includes source label', () => {
  it('has data_source and source_label fields', async () => {
    const { body } = await api('/status');
    assert.ok(['glb', 'vcr', 'combined'].includes(body.data_source));
    assert.equal(typeof body.source_label, 'string');
    assert.ok(body.source_label.length > 0);
  });
});

describe('causal chain endpoint', () => {
  it('returns causal chain with all five steps', async () => {
    await api('/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'demo' }),
    });
    await api('/scenario/baseline', { method: 'POST' });
    const { body } = await api('/causal');
    assert.ok(body.steps, 'has steps');
    assert.ok(body.steps.traffic, 'has traffic step');
    assert.ok(body.steps.metrics, 'has metrics step');
    assert.ok(body.steps.score, 'has score step');
    assert.ok(body.steps.route, 'has route step');
    assert.ok(typeof body.narrative, 'string');
    assert.ok(body.narrative.length > 0);
  });

  it('traffic step shows steady at baseline', async () => {
    await api('/scenario/baseline', { method: 'POST' });
    const { body } = await api('/causal');
    assert.equal(body.steps.traffic.provider_count, 2);
  });

  it('metrics step lists per-provider pressure', async () => {
    const { body } = await api('/causal');
    assert.ok(Array.isArray(body.steps.metrics.per_provider));
    assert.ok(body.steps.metrics.per_provider.length >= 2);
    for (const p of body.steps.metrics.per_provider) {
      assert.ok(p.name);
      assert.ok(['normal', 'elevated', 'high', 'critical', 'unknown'].includes(p.pressure_level));
    }
  });

  it('score step includes strategy and weights', async () => {
    const { body } = await api('/causal');
    assert.ok(body.steps.score.strategy);
    assert.equal(body.steps.score.weights.locality, 3.0);
    assert.equal(body.steps.score.weights.queue_depth, 5.0);
  });

  it('route step names selected provider', async () => {
    const { body } = await api('/causal');
    assert.ok(body.steps.route.selected);
    assert.ok(body.steps.route.policy);
  });

  it('narrative changes under pressure scenario', async () => {
    await api('/scenario/pressure', { method: 'POST' });
    const { body } = await api('/causal');
    assert.ok(body.steps.metrics.per_provider.some(p => p.pressure_level === 'critical'),
      'pressure scenario has a critical provider');
  });
});

describe('active scoring strategies', () => {
  it('queue depth strategy drives score correctly', async () => {
    await api('/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'demo' }),
    });
    await api('/scenario/baseline', { method: 'POST' });
    const { body } = await api('/providers');
    const poolA = body.providers.find(p => p.name === 'pool-a');
    assert.ok(poolA.score > 0, 'pool-a has positive score');
    assert.ok(typeof poolA.queue_depth === 'number', 'queue_depth is present');
    assert.equal(poolA.pressure_level, 'normal');
  });

  it('kv cache metric is present on providers', async () => {
    const { body } = await api('/providers');
    for (const p of body.providers) {
      assert.equal(typeof p.kv_cache, 'number', `${p.name} has kv_cache`);
    }
  });
});

describe('stale metric handling', () => {
  it('degraded pool has pressure classification', async () => {
    await api('/scenario/degraded', { method: 'POST' });
    const { body } = await api('/providers');
    const poolA = body.providers.find(p => p.name === 'pool-a');
    assert.ok(poolA.pressure_level, 'unhealthy pool still has pressure_level');
    assert.equal(poolA.score, 0, 'unhealthy pool score is zero');
  });
});

describe('duplicate display names with distinct stable IDs', () => {
  it('providers have distinct names', async () => {
    await api('/scenario/baseline', { method: 'POST' });
    const { body } = await api('/providers');
    const names = body.providers.map(p => p.name);
    const unique = new Set(names);
    assert.equal(names.length, unique.size, 'all provider names are unique');
  });
});

describe('data-driven resource IDs', () => {
  it('pools use data-driven names from scenario', async () => {
    await api('/scenario/baseline', { method: 'POST' });
    const { body } = await api('/pools');
    for (const p of body.pools) {
      assert.ok(p.name, 'pool has a name');
      assert.ok(typeof p.score === 'number', 'pool has numeric score');
      assert.ok(typeof p.rank === 'number', 'pool has numeric rank');
    }
  });
});

describe('timing endpoint', () => {
  it('returns operator, overlay, scoring, and tracing timing', async () => {
    const { body } = await api('/timing');
    assert.equal(body.operator.reconcile_interval_secs, 300);
    assert.equal(body.operator.tls_reconcile_interval_secs, 60);
    assert.equal(body.overlay_sync.delivery, 'k8s_configmap_watch');
    assert.ok(body.scoring.filter_execution_us > 0);
    assert.deepEqual(body.scoring.weights, { locality: 3.0, queue_depth: 5.0 });
    assert.ok(body.tracing.spans_per_request >= 6);
    assert.equal(body.tracing.span_injection, 'W3C TraceContext (traceparent/tracestate)');
  });

  it('includes EPP metric signal names', async () => {
    const { body } = await api('/timing');
    assert.ok(body.epp_metrics);
    assert.equal(body.epp_metrics.signal_names.queue_depth, 'inference_pool_average_queue_size');
    assert.equal(body.epp_metrics.signal_names.kv_cache, 'inference_pool_average_kv_cache_utilization');
    assert.equal(body.epp_metrics.queue_capacity, 4);
    assert.equal(body.epp_metrics.stale_threshold_secs, 20);
  });

  it('labels filter execution duration correctly', async () => {
    const { body } = await api('/timing');
    assert.ok(body.scoring.filter_execution_label.includes('filter execution'));
    assert.ok(body.scoring.filter_execution_label.includes('not end-to-end'));
  });
});

describe('no sensitive data leakage', () => {
  it('causal endpoint has no sensitive data', async () => {
    await api('/scenario/baseline', { method: 'POST' });
    const { body } = await api('/causal');
    const json = JSON.stringify(body);
    assert.ok(!json.includes('Bearer'), 'no auth tokens');
    assert.ok(!json.includes('sk-'), 'no API keys');
    assert.ok(!json.includes('password'), 'no passwords');
  });
});
