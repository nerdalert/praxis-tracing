import { useEffect, useMemo, useState } from "react";

type WeightedState = any;

const formatRevision = (value: unknown) => {
  const text = String(value || "unavailable");
  return text.length > 16 ? `${text.slice(0, 10)}…${text.slice(-6)}` : text;
};

const percent = (value: unknown) => typeof value === "number" ? `${value.toFixed(value % 1 ? 1 : 0)}%` : "—";
const weightVector = (providers: any[] = []) => providers.map(provider => `${provider.site?.replace("pool-", "") || "?"} ${provider.traffic_weight ?? "—"}`).join(" / ");
const transitionLabel = (transition: any) => {
  if (!transition) return "No completed transition recorded";
  if (transition.action === "pressure") return `baseline → pressure ${transition.target_pool?.replace("pool-", "Pool ") || ""}`;
  return "pressure → baseline recovery";
};
const phaseDescription = (phase: string) => {
  if (phase === "baseline") return "All pools idle; baseline weights are active";
  if (phase === "baseline-transition") return "Resetting all pools to idle";
  if (phase.startsWith("pressure-")) {
    const pool = phase.slice("pressure-".length).replace("pool-", "Pool ").toUpperCase();
    return `${pool} reports a simulated queue depth; updated routing is active`;
  }
  return phase.replaceAll("-", " ");
};

export default function WeightedRoutingDashboard() {
  const [state, setState] = useState<WeightedState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadJob, setLoadJob] = useState<any>(null);
  const [loadRate, setLoadRate] = useState(5);
  const [loadConcurrency, setLoadConcurrency] = useState(6);
  const [loadDuration, setLoadDuration] = useState(60);
  const [loadUntilStopped, setLoadUntilStopped] = useState(false);
  const [loadPool, setLoadPool] = useState("pool-a");
  const [metricValues, setMetricValues] = useState<Record<string, number>>({ "pool-a": 0, "pool-b": 0, "pool-c": 0 });

  const refresh = async () => {
    try {
      const response = await fetch("/api/v1/weighted");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `weighted API returned ${response.status}`);
      setState(data);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "weighted state unavailable");
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const poll = async () => {
      try {
        const response = await fetch("/api/load/status");
        const data = await response.json();
        setLoadJob(data.job || null);
      } catch { /* the weighted state still remains useful */ }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const apply = async (action: string, pool = "pool-a", waiting_requests = action === "pressure" ? 3 : 0) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/weighted/pressure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, pool, waiting_requests }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `pressure update returned ${response.status}`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "pressure update failed");
    } finally {
      setBusy(false);
    }
  };

  const applyAllMetrics = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/weighted/metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queue_depths: metricValues }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `metric update returned ${response.status}`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "metric update failed");
    } finally {
      setBusy(false);
    }
  };

  const startTraffic = async () => {
    setError(null);
    const clearResponse = await fetch("/api/load/clear", { method: "POST" });
    const clearData = await clearResponse.json().catch(() => ({}));
    if (!clearResponse.ok) {
      setError(clearData.error || "Stop the current routing sample before starting a new one");
      return;
    }
    await refresh();
    const response = await fetch("/api/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "sustained", rate: loadRate, concurrency: loadConcurrency,
        duration_seconds: loadDuration, until_stopped: loadUntilStopped, target_pool: loadPool }),
    });
    const data = await response.json();
    if (!response.ok) setError(data.error || `traffic generator returned ${response.status}`);
    else setLoadJob(data.job);
  };

  const stopTraffic = async () => {
    const response = await fetch("/api/load/cancel", { method: "POST" });
    const data = await response.json();
    setLoadJob(data.job || null);
  };

  const clearTraffic = async () => {
    const response = await fetch("/api/load/clear", { method: "POST" });
    const data = await response.json();
    if (!response.ok) setError(data.error || "traffic history could not be cleared");
    else await refresh();
  };

  const providers = state?.providers || [];
  const totalWeight = providers.reduce((sum: number, provider: any) => sum + (provider.traffic_weight || 0), 0);
  const requests = state?.requests || [];
  const summary = state?.request_summary || {};
  const observation = state?.observation || {};
  const samplerRun = state?.sampler_run || null;
  const runSampleSize = samplerRun?.successful_attributed ?? 0;
  const phase = state?.phase || "unavailable";
  const instances = state?.instances || [];
  const gateways = state?.gateways || [];
  const queueDepthMode = state?.strategy === "queueDepth";
  const transition = state?.action?.transition || state?.transition_history?.[0];
  const expected = useMemo(() => providers.map((provider: any) => ({
    ...provider,
    expected: typeof provider.expected_percent === "number"
      ? provider.expected_percent
      : totalWeight ? (provider.traffic_weight || 0) / totalWeight * 100 : null,
  })), [providers, totalWeight]);

  return (
    <main className="app weighted-dashboard" aria-label="Weighted routing dashboard">
      <header className="app-header">
        <div className="brand"><div className="brand-mark">P</div><div><h1>Grid Dynamic Weighting</h1><p>Live pressure-aware provider routing</p></div></div>
        <div className="header-actions"><span className={`badge badge-${state?.available ? "live" : "unknown"}`}>{state?.available ? "LIVE GRID STATE" : "UNAVAILABLE"}</span><span className="badge badge-unknown">TRACING {state?.jaeger?.available ? "LIVE" : "UNAVAILABLE"}</span></div>
      </header>
      <section className="panel demo-guide"><div className="panel-heading compact"><div><span className="eyebrow">Demo guide</span><h2>Grid dynamic weighting demo</h2></div><span className="badge badge-live">LIVE DATA</span></div><p className="panel-note guide-intro"><strong>User story:</strong> As a platform engineer, I want to see how live load metrics from independent inference pools change Grid’s routing preference and the resulting attributed traffic, so I can verify dynamic multi-cluster routing without guessing from logs.</p><p className="panel-note guide-intro"><strong>Topology:</strong> this qualification spans three distinct Kind clusters—<code>grid-llmd-pm-pool-a</code>, <code>grid-llmd-pm-pool-b</code>, and <code>grid-llmd-pm-pool-c</code>—with one neutral llm-d inference pool per cluster: pool-a, pool-b, and pool-c. Each distinct cluster has its own GridSite, provider gateway, EPP metrics endpoint, and two simulator instances; the consumer gateway routes across all three clusters.</p><p className="panel-note"><strong>Equal-capacity baseline:</strong> all three pools are configured with capacity 100. When their reported queue depths are equal, Grid assigns equal routing preference.</p><ol><li>Set every pool’s queue depth to <strong>0</strong>, then wait for all three gateway rows to show <strong>CONVERGED</strong>. <span className="guide-proof">Proves the three cluster-local Grid/Praxis revision chains are ready.</span></li><li>Read <strong>Grid overlay state</strong>: the idle effective weights should be <strong>100 / 100 / 100</strong>, or approximately <strong>33.3% / 33.3% / 33.3%</strong> expected share. <span className="guide-proof">Proves the equal-capacity baseline is published in the live overlay.</span></li><li>Start the <strong>Routing sampler</strong>. It measures recent provider distribution; it does not create simulator load. <span className="guide-proof">Proves real requests can be attributed across the three clusters without changing their metrics.</span></li><li>Set one pool’s queue depth above zero. Grid should reduce that pool’s effective weight while the other idle pools receive more expected share. <span className="guide-proof">Proves EPP metric → Grid recalculation → new effective overlay weight.</span></li><li>Compare <strong>Measured request share</strong> below the cards with the expected share from the current Grid overlay. <span className="guide-proof">Proves the load balancer’s observed provider distribution against Grid’s expected share.</span></li></ol><p className="panel-note">The complete causal proof is: simulator configuration → replacement pod Ready → EPP metric → Grid effective weight → Praxis accepted/serving revision → measured attributed request distribution.</p></section>
      <section className="weighted-toolbar panel">
        <div><span className="eyebrow">Routing state</span><h2>{phaseDescription(phase)}</h2><p className="panel-note">Effective weights are recalculated from the active simulator metric. Sampling traffic measures routing; it does not create simulated load.</p></div>
        {error && <span role="alert" className="error-text">{error}</span>}
      </section>
      <section className="panel simulated-load-controls">
        <div className="panel-heading compact"><div><span className="eyebrow">Simulator operation</span><h2>Simulated load controls</h2></div><span className={`badge badge-${busy ? "unknown" : "live"}`}>{busy ? "UPDATING" : "READY"}</span></div>
        <p className="panel-note">Set the queue depth reported by each llm-d simulator. Changing a value updates simulator configuration, restarts that pool’s simulator pods, and waits for the replacement pod, EPP metric, Grid overlay, and Praxis serving revision. Routing sampler traffic does not create this load.</p>
        <div className="simulated-load-grid">{providers.map((provider: any) => { const value = metricValues[provider.site] ?? 0; return <div className="simulated-load-row" key={provider.site}><div><strong>{provider.site.replace("pool-", "Pool ")}</strong><span>Higher queue depth represents a busier pool; Grid should reduce that pool’s effective routing weight.</span></div><label>Queue depth<input aria-label={`${provider.site} simulated queue depth`} type="number" min="0" max={provider.queue_depth?.capacity ?? 4} value={value} disabled={busy} onChange={(event) => setMetricValues({ ...metricValues, [provider.site]: Number(event.target.value) })} /></label><span className="metric-readout">Current: {provider.queue_depth?.raw_value ?? 0} of {provider.queue_depth?.capacity ?? 4}<small>{provider.queue_depth?.raw_value != null ? `${Math.round(provider.queue_depth.raw_value / (provider.queue_depth.capacity || 4) * 100)}% utilization` : "metric unavailable"}</small></span></div>; })}</div>
        <div className="weighted-actions"><button className="primary-button" disabled={busy} onClick={() => void applyAllMetrics()}>Set all queue depths</button><button className="secondary-button" disabled={busy} onClick={() => { setMetricValues({ "pool-a": 0, "pool-b": 0, "pool-c": 0 }); void apply("baseline"); }}>Reset all pools to idle</button></div>
        {busy && <div role="status" className="operation-stages"><strong>{phaseDescription(phase)}</strong><span>1. Updating simulator metric configuration</span><span>2. Restarting simulator pods</span><span>3. Waiting for replacement pods to become Ready</span><span>4. Waiting for EPP to report the metric</span><span>5. Waiting for Grid to recalculate weights</span><span>6. Waiting for Praxis to serve the revision</span></div>}
      </section>
      <section className="panel weighted-traffic-controls">
        <div className="panel-heading compact"><div><span className="eyebrow">Observed request traffic</span><h2>Routing sampler</h2></div><span className={`badge badge-${loadJob?.running ? "live" : "unknown"}`}>{loadJob?.running ? "RUNNING" : "STOPPED"}</span></div>
        <div className="traffic-controls-row">
          <label>Requests/sec<input type="number" min="0.1" max="50" step="0.1" value={loadRate} disabled={loadJob?.running} onChange={(event) => setLoadRate(Number(event.target.value))} /></label>
          <label>Concurrency<input type="number" min="1" max="24" value={loadConcurrency} disabled={loadJob?.running} onChange={(event) => setLoadConcurrency(Number(event.target.value))} /></label>
          <label>Duration (sec)<input type="number" min="5" max="300" value={loadDuration} disabled={loadJob?.running} onChange={(event) => setLoadDuration(Number(event.target.value))} /></label>
          <label>Ingress gateway<select value={loadPool} disabled={loadJob?.running} onChange={(event) => setLoadPool(event.target.value)}><option value="pool-a">Pool A</option><option value="pool-b">Pool B</option><option value="pool-c">Pool C</option></select></label>
          <label className="checkbox-label"><input type="checkbox" checked={loadUntilStopped} disabled={loadJob?.running} onChange={(event) => setLoadUntilStopped(event.target.checked)} /> Until stopped</label>
          <button className="primary-button" disabled={loadJob?.running} onClick={() => void startTraffic()}>Start routing sampler</button>
          <button className="secondary-button" disabled={!loadJob?.running} onClick={() => void stopTraffic()}>Stop</button>
          <button className="icon-button" disabled={loadJob?.running} title="Clear request history" aria-label="Clear request history" onClick={() => void clearTraffic()}>⌫</button>
        </div>
        <p className="panel-note">Ingress selects where requests enter; Grid selects the provider. This sampler measures attributed routing and does not modify simulator metrics.</p>
        {loadJob && <div className="load-summary"><div><span>Elapsed</span><strong>{loadJob.started_at ? `${Math.max(0, Math.round((Date.now() - Date.parse(loadJob.started_at)) / 1000))}s` : "—"}</strong></div><div><span>Total requests</span><strong>{loadJob.completed ?? 0}</strong></div><div><span>Successful</span><strong>{loadJob.succeeded ?? 0}</strong></div><div><span>Failed</span><strong>{loadJob.failed ?? 0}</strong></div><div><span>Entry gateway</span><strong>{loadJob.target_pool ? `Pool ${loadJob.target_pool.replace("pool-", "")}` : "—"}</strong><small>where requests enter; Grid still selects the provider</small></div></div>}
      </section>
      <section className="panel sampler-result"><div className="panel-heading compact"><div><span className="eyebrow">Routing sampler result</span><h2>Measured request share</h2><p className="section-explanation">This is the result of the current sampler run, not the overlay setting. Starting a new run clears the previous run totals.</p></div></div><p className="sampler-run-total">Current run: <strong>{samplerRun ? `${runSampleSize} successful requests with a selected provider, of ${samplerRun.total_requests ?? 0} total` : "no sampler run yet"}</strong>. The percentages below use the complete current run; the rolling window is shown separately.</p><div className="distribution-list">{expected.map((provider: any) => <div className="distribution-card" key={provider.site}><div><strong>{provider.site}</strong><span>Expected from current overlay: {percent(provider.expected)}</span><span>Current run: {samplerRun ? `${provider.run_observed_requests ?? 0} successful requests selected this provider` : "—"}</span><span>Latest window: {provider.observed_requests ?? 0} of {observation.sample_size ?? 0} successful requests with a selected provider</span></div><strong className="measured-share">{provider.run_observed_percent == null ? "—" : `${provider.run_observed_percent.toFixed(1)}% measured`}</strong></div>)}</div><p className="panel-note">Measured share uses all successful requests with a selected provider in the current sampler run, so a 120-second run remains represented after its older request rows leave the bounded table. Latest window: {observation.window_size ?? 100} generated requests, of which {observation.sample_size ?? 0} had a successful provider selection. Phases: {Object.entries(samplerRun?.phases || observation.phases || {}).map(([name, count]) => `${name} (${count})`).join(", ") || "none"}</p><div className="summary-stats">{[["Total", samplerRun?.total_requests ?? summary.total ?? requests.length], ["Successful", samplerRun?.successful ?? summary.successful ?? "—"], ["HTTP failures", samplerRun ? samplerRun.failed : (summary.failed ?? "—")], ["Transport failures", samplerRun?.transport_failures ?? requests.filter((request: any) => request.status === 0).length], ["P50", `${samplerRun?.latency_ms?.p50 ?? summary.latency_ms?.p50 ?? "—"} ms`], ["P95", `${samplerRun?.latency_ms?.p95 ?? summary.latency_ms?.p95 ?? "—"} ms`], ["P99", `${samplerRun?.latency_ms?.p99 ?? summary.latency_ms?.p99 ?? "—"} ms`], ["Maximum", `${samplerRun?.latency_ms?.max ?? summary.latency_ms?.max ?? "—"} ms`]].map(([label, value]) => <div key={String(label)}><span>{label}</span><b>{value}</b></div>)}</div></section>
      <section className="panel overlay-state-heading"><div className="panel-heading compact"><div><span className="eyebrow">Grid overlay state</span><h2>Currently served routing preference</h2></div><span className="badge badge-live">LIVE · REFRESH 1S</span></div><div className="overlay-vector" aria-label="Current expected new-request shares">{expected.map((provider: any) => <div key={provider.site}><span>{provider.site}</span><b>{percent(provider.expected)}</b></div>)}</div><p className="panel-note">These are the expected shares for new requests from the effective overlay published by Grid and currently served by Praxis. Pools marked <code>existing_only</code> remain available only to existing session affinity or drain. The sampler result above is measured separately from real provider selections.</p></section>
      <section className="weighted-grid">
        {expected.map((provider: any) => {
          const observed = provider.observed_percent;
          return <article className="panel weighted-pool" key={provider.stable_id || provider.site}>
            <div className="panel-heading compact"><div><span className="eyebrow">Pool / site</span><h2>{provider.site}</h2><p>{provider.cluster}</p></div><span className={`status-dot ${provider.healthy ? "normal" : "unknown"}`} /></div>
            <div className="weight-hero"><b>{percent(provider.expected_percent ?? provider.expected)}</b><span>expected new-request share</span><small>{provider.admission_state === "existing_only" ? "Not eligible for new requests; retained for existing sessions" : "Based on the currently eligible pools"}</small></div><p className="data-provenance">Source: {provider.effective_weight_source || "live Grid overlay"}. Refreshed {state?.generated_at ? new Date(state.generated_at).toLocaleTimeString() : "—"}.</p>
            <div className="weight-bar"><i style={{ width: `${provider.expected || 0}%` }} /></div>
            <dl className="weighted-facts"><div><dt>Configured capacity</dt><dd>{provider.capacity_weight ?? "—"}</dd></div>{queueDepthMode ? <><div><dt>Queue depth</dt><dd>{provider.queue_depth?.raw_value ?? provider.queue_depth?.value ?? "—"} / {provider.queue_depth?.capacity ?? 4}<small className="fact-source">EPP reported / configured capacity</small></dd></div><div><dt>Queue utilization</dt><dd>{provider.queue_depth?.raw_value != null ? `${Math.round(provider.queue_depth.raw_value / (provider.queue_depth.capacity || 4) * 100)}%` : "—"}<small className="fact-source">depth ÷ capacity</small></dd></div></> : <div><dt>KV-cache utilization</dt><dd>{provider.kv_cache?.value == null ? "—" : percent(provider.kv_cache.value * 100)}<small className="fact-source">EPP reported</small></dd></div>}<div><dt>Measured request share</dt><dd>{observed == null ? "—" : `${observed.toFixed(1)}%`}<small className="fact-source">successful attributed sampler requests</small></dd></div><div><dt>Admission</dt><dd>{provider.admission_state || "—"}</dd></div></dl>
            <div className="simulator-list"><span className="eyebrow">Simulator instances</span>{instances.filter((item: any) => item.pool === provider.site).map((item: any) => <div className="simulator-row" key={item.name}><span>Simulator {String(item.instance || "").replace(/^vcr-/, "")}</span><span className="mono" title={item.name}>pod {item.name.replace(/^vcr-/, "simulator-")}</span><Badge state={item.ready ? "Ready" : item.phase} /></div>)}</div>
          </article>;
        })}
      </section>
      <section className="panel transition-context"><div className="panel-heading compact"><div><span className="eyebrow">Revision context</span><h2>What changed</h2></div><span className={`badge badge-${transition ? "live" : "unknown"}`}>{transition ? "RECORDED" : "NO TRANSITION"}</span></div>{transition ? <div className="transition-facts"><div><span>Change</span><strong>{transitionLabel(transition)}</strong></div><div><span>Completed</span><strong>{transition.completed_at ? new Date(transition.completed_at).toLocaleTimeString() : "—"}</strong></div><div><span>Convergence duration</span><strong>{Number.isFinite(transition.duration_ms) ? `${transition.duration_ms} ms` : "—"}</strong></div><div><span>Effective weights</span><strong>{weightVector(transition.before?.providers)} → {weightVector(transition.after?.providers)}</strong></div><div><span>Revisions</span><strong>{transition.after?.gateways?.map((gateway: any) => `${gateway.pool}: ${formatRevision(gateway.revision)}`).join(" · ") || "—"}</strong></div></div> : <p className="panel-note">Apply a simulator pressure action to record the live metric-to-overlay transition.</p>}</section>
      <section className="panel request-stream"><div className="panel-heading compact"><div><span className="eyebrow">Provider-selected requests</span><h2>Recent request history</h2></div></div><div className="request-table-wrap"><table className="request-table weighted-request-table"><thead><tr><th>Time</th><th>HTTP</th><th>Phase</th><th>Ingress</th><th>Provider</th><th>Latency</th><th>Overlay revision</th></tr></thead><tbody>{requests.slice(0, 20).map((request: any, index: number) => <tr key={request.request_id || index}><td className="mono">{request.started_at ? new Date(request.started_at).toLocaleTimeString() : "—"}</td><td><span className={`http-status ${request.ok ? "ok" : "error"}`}>{request.status || "—"}</span></td><td>{request.phase || "—"}</td><td>{request.consumer_gateway || "—"}</td><td>{request.provider_pool || request.provider || "unselected"}</td><td>{request.duration_ms ?? "—"} ms</td><td><code title={request.overlay_revision_source || "No revision available"}>{formatRevision(request.overlay_revision)}</code></td></tr>)}</tbody></table></div></section>
      <section className="panel convergence-panel"><div className="panel-heading compact"><div><span className="eyebrow">Atomic serving state</span><h2>Revision convergence</h2><p className="section-explanation">Each gateway must serve exactly the overlay revision accepted from Grid. This confirms the complete routing update is active.</p></div><span className={`badge badge-${gateways.every((gateway: any) => gateway.converged) ? "live" : "unknown"}`}>{gateways.every((gateway: any) => gateway.converged) ? "CONVERGED" : "UPDATING"}</span></div><div className="gateway-revisions">{gateways.map((gateway: any) => <div className="gateway-revision-card" key={gateway.context}><strong>{gateway.pool}</strong><span><b>Grid overlay</b><code title={gateway.grid_revision}>{formatRevision(gateway.grid_revision)}</code></span><span><b>Praxis accepted</b><code title={gateway.accepted_revision}>{formatRevision(gateway.accepted_revision)}</code></span><span><b>Praxis serving</b><code title={gateway.serving_revision}>{formatRevision(gateway.serving_revision)}</code></span><small>{gateway.converged ? "All three revisions match" : "Revisions differ; update still in progress"}</small></div>)}</div></section>
      <footer className="panel weighted-footer"><span>Grid evidence: live · Request attribution: live · Distributed tracing: {state?.jaeger?.available ? "live" : "unavailable"}</span></footer>
    </main>
  );
}

function Badge({ state }: { state: string }) { return <span className={`badge badge-${state === "Ready" ? "live" : "unknown"}`}>{state}</span>; }
