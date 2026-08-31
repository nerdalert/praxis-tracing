// Cloud-burst runtime queue-metric control.
//
// Extracted from server.js so the pressure-slider control path is a single,
// dependency-injected, unit-testable unit rather than three near-duplicate
// helpers. Every effect (kubectl, the simulator runtime-metric write) is
// injected, so the behavior can be proven without a live cluster.
//
// Design rules enforced here:
//   * Queue depth is an integer count. Zero is a real, meaningful value and is
//     never coerced to a ratio or dropped as a falsy value.
//   * Each provider is written independently (its own ConfigMap + runtime API
//     write). Resetting or setting one provider never touches another's state.
//   * A provider's in-memory metric is updated only after BOTH its ConfigMap
//     patch and its runtime write succeed, so a failed runtime write can never
//     make the UI display a value the simulator never accepted.
//   * These helpers never change provider health, never scale a simulator
//     Deployment, and never force Grid reconciliation. Grid observes the
//     changed queue metric through its own polling/reconciliation loop.

// Replace the `waiting-requests:` line in a simulator config.yaml with an
// explicit integer. Pure and independent of how the value is sourced.
export function replaceWaitingRequests(source, queue) {
  if (typeof source !== 'string') throw new Error('simulator config.yaml is unavailable');
  return source.replace(/waiting-requests:\s*[^\n]*/, `waiting-requests: ${queue}`);
}

// Normalize a slider/API value into an integer queue depth. Zero stays zero;
// there is no 0..1 ratio scaling (a queue depth of 1 must mean 1, not a
// fraction of capacity). `max` bounds the accepted range.
export function normalizeQueueDepth(value, { max = 1000 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > max) {
    throw new Error(`metric value must be an integer between 0 and ${max}`);
  }
  return Math.round(number);
}

// Provider inventory is derived from configuration, not from the accepted
// overlay, so every configured control stays visible even when a provider is
// pressured, unhealthy, or withdrawn from the accepted overlay.
export function providerInventory(keys, names, simulators) {
  return keys.map((key, index) => ({ key, name: names[index], simulator: simulators[index] }));
}

// A monotonic per-key sequence guard for the client (and any caller) so an
// older in-flight write can never overwrite the latest requested value.
export function isLatest(seqMap, key, seq) {
  return seqMap.get(key) === seq;
}

// Write one provider's queue metric to both its ConfigMap (durable) and its
// runtime metrics API (live). Throws if either write fails; the caller decides
// whether to record the value.
async function writeProviderMetric(deps, provider, queue) {
  const { kubectl, setRuntimeMetric, simProviderName, controlTimeout } = deps;
  const providerName = simProviderName(provider);
  if (!providerName) throw new Error(`unknown configured local provider: ${provider}`);
  const name = `${providerName}-config`;
  const document = JSON.parse(await kubectl(['get', 'configmap', name, '-o', 'json']));
  const source = document?.data?.['config.yaml'];
  if (typeof source !== 'string') throw new Error(`${name} config.yaml is unavailable`);
  const updated = replaceWaitingRequests(source, queue);
  await kubectl(
    ['patch', 'configmap', name, '--type=merge', '-p', JSON.stringify({ data: { 'config.yaml': updated } })],
    controlTimeout,
  );
  // The runtime write is always sent, including for zero, so removing pressure
  // takes effect immediately rather than waiting for a ConfigMap remount.
  await setRuntimeMetric(providerName, queue);
}

// Set queue metrics for a map of { providerKey: queueDepth }. Each provider is
// written independently; a failure on one is reported without silently marking
// it (or the others) as changed. Providers not present in `values` are left
// untouched.
export async function runMetrics(deps, values) {
  const { simProviderName, state } = deps;
  const entries = Object.entries(values).filter(([provider]) => simProviderName(provider));
  const results = await Promise.allSettled(entries.map(([provider, queue]) => writeProviderMetric(deps, provider, queue)));
  const errors = [];
  results.forEach((result, index) => {
    const [provider, queue] = entries[index];
    if (result.status === 'fulfilled') {
      state.metrics[provider] = queue;
    } else {
      errors.push(`${provider}: ${result.reason?.message || result.reason}`);
    }
  });
  if (errors.length) throw new Error(`metric update failed for ${errors.join('; ')}`);
  return { metrics: { ...state.metrics } };
}

// Set a single provider's queue depth.
export async function runMetric(deps, provider, queue) {
  return runMetrics(deps, { [provider]: queue });
}

// Reset every configured provider's queue metric to zero. Writes both the
// ConfigMap and the runtime API for each provider. Does not touch health or
// Deployment state.
export async function resetMetrics(deps) {
  return runMetrics(deps, Object.fromEntries(deps.providerKeys.map(key => [key, 0])));
}

// Stop all queue pressure: cancel any generator job, clear every provider's
// runtime queue metric to zero, then scale down the optional load Deployment.
// The metric reset is the source of truth; the load Deployment is best-effort.
export async function stopAllPressure(deps) {
  deps.cancelPressureJob?.();
  await resetMetrics(deps);
  if (deps.loadDeploy) {
    // The generator Deployment is optional on simulator-backed installs; its
    // absence must not make the stop control fail after metrics are cleared.
    try {
      await deps.kubectl(['scale', `deploy/${deps.loadDeploy}`, '--replicas=0'], deps.controlTimeout);
    } catch { /* optional load deployment */ }
  }
}
