import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeQueueDepth,
  replaceWaitingRequests,
  providerInventory,
  isLatest,
  runMetric,
  runMetrics,
  resetMetrics,
  stopAllPressure,
} from '../cloud-burst-metrics.js';

// Four providers, mirroring the live RHOAI cloud-burst topology
// (llm-d-east-1 / -west-1 / ... ). The module is provider-count agnostic; the
// tests use four to match the failing UI report.
const KEYS = ['a', 'b', 'c', 'd'];
const NAMES = ['llm-d-east-1', 'llm-d-west-1', 'llm-d-central-1', 'llm-d-south-1'];
const SIMS = ['sim-east-1', 'sim-west-1', 'sim-central-1', 'sim-south-1'];
const simProviderName = (key) => { const i = KEYS.indexOf(String(key)); return i >= 0 ? SIMS[i] : null; };

// Build injectable effects with recording fakes. `runtimeFail` is a set of
// simulator names whose runtime write should reject (to exercise failure
// paths); `scaleFail` makes the load-Deployment scale reject.
function makeDeps({ metrics, health, disabled, runtimeFail = new Set(), scaleFail = false } = {}) {
  const calls = { configPatch: [], runtime: [], scale: [], get: [], cancelled: 0 };
  const kubectl = async (args) => {
    const [verb, kind, name] = args;
    if (verb === 'get' && kind === 'configmap') {
      calls.get.push(name);
      return JSON.stringify({ data: { 'config.yaml': `port: 8000\nfake-metrics:\n  waiting-requests: 3\n` } });
    }
    if (verb === 'patch' && kind === 'configmap') {
      const payload = JSON.parse(args[args.indexOf('-p') + 1]);
      calls.configPatch.push({ name, config: payload.data['config.yaml'] });
      return '';
    }
    if (verb === 'scale') {
      calls.scale.push(args[1]);
      if (scaleFail) throw new Error('load deployment not found');
      return '';
    }
    throw new Error(`unexpected kubectl call: ${args.join(' ')}`);
  };
  const setRuntimeMetric = async (providerName, queue) => {
    calls.runtime.push({ providerName, queue });
    if (runtimeFail.has(providerName)) throw new Error(`${providerName} runtime write failed`);
  };
  const state = {
    metrics: { ...(metrics || Object.fromEntries(KEYS.map(k => [k, 0]))) },
    health: { ...(health || Object.fromEntries(KEYS.map(k => [k, 'healthy']))) },
    disabled: { ...(disabled || Object.fromEntries(KEYS.map(k => [k, false]))) },
  };
  const deps = {
    kubectl, setRuntimeMetric, simProviderName, providerKeys: KEYS,
    controlTimeout: 1000, loadDeploy: 'epp-load', state,
    cancelPressureJob: () => { calls.cancelled += 1; },
  };
  return { deps, calls, state };
}

describe('cloud-burst queue metric normalization', () => {
  it('treats values as integer queue depth without ratio scaling', () => {
    // Regression: a value of 1 was previously scaled to CB_QUEUE_CAPACITY (8).
    assert.equal(normalizeQueueDepth(1), 1);
    assert.equal(normalizeQueueDepth(10), 10);
    assert.equal(normalizeQueueDepth('7'), 7);
  });
  it('keeps zero as zero and never drops it', () => {
    assert.equal(normalizeQueueDepth(0), 0);
    assert.equal(replaceWaitingRequests('a:\n  waiting-requests: 9\n', 0), 'a:\n  waiting-requests: 0\n');
  });
  it('rejects out-of-range values', () => {
    assert.throws(() => normalizeQueueDepth(-1));
    assert.throws(() => normalizeQueueDepth(11, { max: 10 }));
    assert.throws(() => normalizeQueueDepth('nope'));
  });
});

describe('cloud-burst metric control', () => {
  it('1. 10 -> 0 writes both the ConfigMap and the runtime metric each time', async () => {
    const { deps, calls, state } = makeDeps();
    await runMetric(deps, 'a', 10);
    await runMetric(deps, 'a', 0);
    // Two ConfigMap patches, two runtime writes, carrying 10 then 0.
    assert.deepEqual(calls.configPatch.map(c => c.config.match(/waiting-requests: (\d+)/)[1]), ['10', '0']);
    assert.deepEqual(calls.runtime, [
      { providerName: 'sim-east-1', queue: 10 },
      { providerName: 'sim-east-1', queue: 0 },
    ]);
    assert.equal(state.metrics.a, 0);
  });

  it('2. zero is written as a real value, not dropped as falsy', async () => {
    const { deps, calls } = makeDeps({ metrics: { a: 9, b: 0, c: 0, d: 0 } });
    await runMetric(deps, 'a', 0);
    assert.equal(calls.runtime.length, 1);
    assert.deepEqual(calls.runtime[0], { providerName: 'sim-east-1', queue: 0 });
    assert.match(calls.configPatch[0].config, /waiting-requests: 0/);
  });

  it('3. reset writes zero to every configured provider', async () => {
    const { deps, calls, state } = makeDeps({ metrics: { a: 10, b: 7, c: 9, d: 4 } });
    await resetMetrics(deps);
    assert.deepEqual(calls.runtime.map(r => r.providerName).sort(), [...SIMS].sort());
    assert.ok(calls.runtime.every(r => r.queue === 0));
    assert.deepEqual(state.metrics, { a: 0, b: 0, c: 0, d: 0 });
  });

  it('4. stop-all-pressure clears all four runtime metrics even if the load deploy is absent', async () => {
    const { deps, calls, state } = makeDeps({ metrics: { a: 10, b: 10, c: 10, d: 10 }, scaleFail: true });
    await stopAllPressure(deps); // must not throw despite the optional load deploy failing
    assert.equal(calls.cancelled, 1);
    assert.equal(calls.runtime.filter(r => r.queue === 0).length, 4);
    assert.deepEqual(state.metrics, { a: 0, b: 0, c: 0, d: 0 });
    assert.deepEqual(calls.scale, ['deploy/epp-load']); // attempted, best-effort
  });

  it('5. resetting one provider does not change the other three', async () => {
    const { deps, calls, state } = makeDeps({ metrics: { a: 5, b: 6, c: 7, d: 8 } });
    await runMetric(deps, 'a', 0);
    assert.deepEqual(calls.runtime, [{ providerName: 'sim-east-1', queue: 0 }]);
    assert.deepEqual(state.metrics, { a: 0, b: 6, c: 7, d: 8 });
  });

  it('6. a queue reset does not change provider health', async () => {
    const { deps, state } = makeDeps({ health: { a: 'unhealthy', b: 'healthy', c: 'disabled', d: 'healthy' } });
    await resetMetrics(deps);
    assert.deepEqual(state.health, { a: 'unhealthy', b: 'healthy', c: 'disabled', d: 'healthy' });
  });

  it('7. a queue reset never scales a simulator Deployment', async () => {
    const { deps, calls } = makeDeps({ metrics: { a: 10, b: 10, c: 10, d: 10 } });
    await resetMetrics(deps);
    assert.deepEqual(calls.scale, []); // reset touches no Deployment at all
    const stop = makeDeps({ metrics: { a: 10, b: 10, c: 10, d: 10 } });
    await stopAllPressure(stop.deps);
    // stop-all-pressure only scales the optional load generator, never a sim.
    assert.deepEqual(stop.calls.scale, ['deploy/epp-load']);
    assert.ok(!stop.calls.scale.some(name => SIMS.some(sim => name.includes(sim))));
  });

  it('8. provider inventory stays visible independent of the accepted overlay', () => {
    // Even with only one candidate in the overlay, all four controls exist.
    const inventory = providerInventory(KEYS, NAMES, SIMS);
    assert.equal(inventory.length, 4);
    assert.deepEqual(inventory.map(p => p.name), NAMES);
    assert.ok(inventory.every(p => p.key && p.simulator));
  });

  it('9. a failed runtime write throws and does not falsely record zero', async () => {
    const { deps, state } = makeDeps({ metrics: { a: 10, b: 5, c: 5, d: 5 }, runtimeFail: new Set(['sim-east-1']) });
    await assert.rejects(() => runMetric(deps, 'a', 0), /runtime write failed/);
    // The provider's recorded metric is NOT set to the value the simulator
    // never accepted; the UI reads this and shows the error instead of 0.
    assert.equal(state.metrics.a, 10);
  });

  it('9b. reset reports failure but still zeroes the providers that succeeded', async () => {
    const { deps, state } = makeDeps({ metrics: { a: 9, b: 9, c: 9, d: 9 }, runtimeFail: new Set(['sim-central-1']) });
    await assert.rejects(() => resetMetrics(deps), /metric update failed for c/);
    assert.equal(state.metrics.a, 0);
    assert.equal(state.metrics.b, 0);
    assert.equal(state.metrics.c, 9); // failed provider keeps its prior value
    assert.equal(state.metrics.d, 0);
  });

  it('10. a stale write cannot overwrite the latest requested value', () => {
    // The client stamps each write with a monotonic per-provider sequence;
    // only the latest may reconcile state when it resolves.
    const seq = new Map();
    seq.set('a', 1);
    seq.set('a', 2); // a newer drag superseded the first
    assert.equal(isLatest(seq, 'a', 1), false); // stale response is ignored
    assert.equal(isLatest(seq, 'a', 2), true);  // latest response wins
  });
});
