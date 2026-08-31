import React, { useCallback, useEffect, useRef, useState } from "react";

// Cloud-burst pressure + failover visualization. Feature-gated by the server
// (status.cloud_burst); this component only renders when that gate is on, so
// the base quota demo is unaffected. Data comes from GET /api/v1/cloud-burst;
// the load toggle POSTs /api/v1/cloud-burst/load.

type CBGroup = {
  site: string; cluster: string; group: number;
  admission: string | null; tier: string | null; external: boolean; fresh?: boolean;
  provider?: string; gateway?: string | null;
};
type CBMode = { label: string; capacity: number; replicas: number };
type CBStatus = {
  enabled: boolean; error?: string;
  external_target?: string; queue_depth?: number | null; queue_capacity?: number;
  pressure?: number | null; load_on?: boolean; load_replicas?: number;
  local_admission?: string | null; pressure_active?: boolean; cloud_burst_active?: boolean; burst_active?: boolean; groups?: CBGroup[];
  modes?: Record<string, CBMode>; default_mode?: string;
  overlay_revision?: { value?: string } | null;
  controls?: { providers?: Array<{ key: string; name: string; simulator: string }>; metrics: Record<string, number>; health: Record<string, string>; disabled?: Record<string, boolean>; weights: Record<string, number>; allocation: { enforcement: string; limit: number | null; revision: number | string; verified?: boolean }; last_action?: { type: string; id?: string; at?: string } | null };
};
type CBCost = {
  enabled: boolean; source?: string; telemetry_quality?: string;
  pricing?: { revision: string; model: string; currency: string; input_micros_per_million: number; output_micros_per_million: number };
  cloud_hits?: number; local_hits?: number; cloud_input_tokens?: number | null; cloud_output_tokens?: number | null;
  cloud_cost_micros?: number | null; all_cloud_cost_micros?: number | null; saved_vs_all_cloud_micros?: number | null;
  cloud_providers?: Array<{ provider: string; hits: number; input_tokens: number; output_tokens: number; cost_micros: number }>;
  recent_cloud_hits?: Array<{ at: string; trace_id?: string | null; input_tokens: number; output_tokens: number; cost_micros: number }>;
  timeline?: Array<{ at: string; local_hits: number; cloud_hits: number; cloud_cost_micros: number }>;
  limitations?: string[];
};

const ENTER = 0.85; // stabilized admission enter threshold

export default function CloudBurstPanel() {
  const [s, setS] = useState<CBStatus | null>(null);
  const [cost, setCost] = useState<CBCost | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [providerBusy, setProviderBusy] = useState<Record<string, boolean>>({});
  // Backend-sensitivity mode: "sim" (kind mock, deep queue) vs "gpu" (real GPU,
  // saturates fast). Drives generator load AND gauge capacity. Defaults to the
  // server's TRACING_UI_CB_MODE once the first status arrives.
  const [mode, setMode] = useState<string | null>(null);
  const [weights, setWeights] = useState({ a: 50, b: 30, c: 20 });
  const [allocationLimit, setAllocationLimit] = useState(10000);
  const [tourIndex, setTourIndex] = useState(0);
  const timer = useRef<number | null>(null);
  // The slider is a draft control: moving it only stages a value; nothing is
  // written until the operator clicks Set. `sliderDraft` holds the staged value
  // per provider (in steps of 5).
  const [sliderDraft, setSliderDraft] = useState<Record<string, number>>({});
  // Optimistic per-provider queue depth applied on Set. While a provider has an
  // in-flight write its readout follows the operator's intent instead of the 3s
  // poll, so a change cannot be reverted by a stale poll. Cleared once the
  // latest write for that provider settles.
  const [localMetrics, setLocalMetrics] = useState<Record<string, number>>({});
  const [metricBusy, setMetricBusy] = useState<Record<string, boolean>>({});
  const metricSeq = useRef<Map<string, number>>(new Map());
  const metricPending = useRef<Set<string>>(new Set());

  const poll = useCallback(async () => {
    try {
      const r = await fetch("/api/v1/cloud-burst");
      const j = (await r.json()) as CBStatus;
      setS(j);
      // Never let a poll overwrite a provider the operator is still adjusting.
      setLocalMetrics((current) => {
        const next: Record<string, number> = {};
        for (const key of Object.keys(current)) if (metricPending.current.has(key)) next[key] = current[key];
        return next;
      });
      setMode((m) => m ?? j.default_mode ?? "sim");
      if (j.enabled) {
        const costResponse = await fetch("/api/v1/cloud-burst/cost");
        if (costResponse.ok) setCost((await costResponse.json()) as CBCost);
      }
    } catch { /* transient */ }
  }, []);

  useEffect(() => {
    poll();
    timer.current = window.setInterval(poll, 3000);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, [poll]);

  const applyLoad = async (on: boolean, m: string) => {
    setBusy(true);
    setControlError(null);
    try {
      const response = await fetch("/api/v1/cloud-burst/load", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ on, mode: m }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `load control returned ${response.status}`);
      }
      await poll();
    } catch (error) {
      setControlError(error instanceof Error ? error.message : "load control unavailable");
    } finally { setBusy(false); }
  };

  const toggleLoad = () => { if (s) applyLoad(!s.load_on, mode || s.default_mode || "sim"); };

  // Switching backend re-scales the generator to the new preset if load is on.
  const changeMode = (m: string) => {
    setMode(m);
    if (s?.load_on) applyLoad(true, m);
  };

  const control = async (path: string, body: Record<string, unknown>) => {
    setBusy(true); setControlError(null);
    try {
      const response = await fetch(`/api/v1/cloud-burst/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `control returned ${response.status}`);
      const failedResult = Array.isArray(data.results) ? data.results.find((result: { error?: unknown }) => result?.error) : null;
      if (data.ok === false || failedResult) throw new Error(failedResult?.error?.type || "live traffic was not admitted");
      await poll();
      return data;
    } catch (error) { setControlError(error instanceof Error ? error.message : "control unavailable"); return null; }
    finally { setBusy(false); }
  };

  // Apply one provider's staged queue depth. Only invoked by the Set button, so
  // nothing is written while the slider moves. A monotonic per-provider
  // sequence makes the latest request authoritative: an older in-flight write
  // that resolves late is ignored and can never overwrite a newer value
  // (requirement 10). A failed runtime write surfaces an error and drops the
  // optimistic value so the UI does not falsely display a depth the simulator
  // never accepted. The panel is never globally disabled, so live traffic and
  // other controls keep working while pressure changes (requirement 8).
  const applyMetric = useCallback(async (provider: string, value: number) => {
    const seq = (metricSeq.current.get(provider) || 0) + 1;
    metricSeq.current.set(provider, seq);
    metricPending.current.add(provider);
    setControlError(null);
    setMetricBusy((current) => ({ ...current, [provider]: true }));
    setLocalMetrics((current) => ({ ...current, [provider]: value })); // optimistic
    const settle = (mutate: (next: Record<string, number>) => void) => {
      if (metricSeq.current.get(provider) !== seq) return false; // superseded
      metricPending.current.delete(provider);
      setMetricBusy((current) => ({ ...current, [provider]: false }));
      setLocalMetrics((current) => { const next = { ...current }; mutate(next); return next; });
      setSliderDraft((current) => { const next = { ...current }; delete next[provider]; return next; });
      return true;
    };
    try {
      const response = await fetch("/api/v1/cloud-burst/metric", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, value }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error || `control returned ${response.status}`);
      if (settle((next) => { delete next[provider]; })) await poll();
    } catch (error) {
      // Drop the optimistic value so a failed write never shows a false depth.
      if (settle((next) => { delete next[provider]; })) {
        setControlError(error instanceof Error ? error.message : "metric control unavailable");
        await poll();
      }
    }
  }, [poll]);

  const resetMetrics = () => control("metric", { reset: true });
  const stopAllPressure = async () => {
    setBusy(true); setControlError(null);
    try {
      const response = await fetch("/api/v1/cloud-burst/stop", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `stop control returned ${response.status}`);
      await poll();
    } catch (error) { setControlError(error instanceof Error ? error.message : "stop control unavailable"); }
    finally { setBusy(false); }
  };
  const runScenario = (id: string) => control("scenario", { id });
  const publishWeights = () => control("weights", weights);
  const setHealth = (provider: string, state: string) => control("health", { provider, state });
  const setProviderDisabled = async (provider: string, disabled: boolean) => {
    setProviderBusy((current) => ({ ...current, [provider]: true }));
    try {
      await control("provider", { provider, disabled });
    } finally {
      setProviderBusy((current) => ({ ...current, [provider]: false }));
    }
  };
  const setAllocation = (enforcement: string, limit = allocationLimit) => control("allocation", { principal: "loadgen", enforcement, limit });

  const tour = [
    ["Baseline weighted local", "Calm metrics; observe the 50/30/20 local split."],
    ["Partial pressure", "Pressure provider A; B and C absorb new traffic while cloud stays dormant."],
    ["Progressive pressure", "Pressure A and B; provider C still protects the local tier."],
    ["Full pressure and burst", "Saturate all locals; bounded traffic reaches real OpenAI."],
    ["Recovery", "Reset metrics and watch local weighted routing return."],
    ["Live reweight", "Change local weights without restarting gateways."],
    ["Bounded cloud usage", "Use a few real cloud requests to populate observed usage and cost."],
    ["Evidence and cleanup", "Return to calm metrics and leave the sim-only topology ready for review."],
  ];

  if (!s || !s.enabled) return null;

  const modes = s.modes || {};
  const activeMode = mode || s.default_mode || "sim";
  const preset = modes[activeMode];
  const queue = typeof s.queue_depth === "number" ? s.queue_depth : null;
  // Gauge capacity follows the selected backend-sensitivity preset so "Real GPU"
  // visibly crosses the enter threshold on far less queue than "Simulation".
  const cap = preset?.capacity || s.queue_capacity || 8;
  const pressure = queue != null && cap > 0 ? Math.max(0, Math.min(1, queue / cap)) : 0;
  const pressureActive = Boolean(s.pressure_active ?? s.local_admission === "existing_only");
  const burst = Boolean(s.cloud_burst_active ?? s.burst_active);
  const pressureRunning = Boolean(s.load_on || pressureActive);
  const configuredProviders = s.controls?.providers || [];
  const overlayProviders = s.groups || [];
  const localProviders = configuredProviders;
  const localKeys = configuredProviders.map((provider) => provider.key);
  const disabledProviderNames = new Set(configuredProviders.filter((provider) => s.controls?.disabled?.[provider.key]).map((provider) => provider.name));
  const isGpu = activeMode === "gpu";
  const gatewayDisplayName = (value: string) => {
    const normalized = String(value || "provider").replace(/^(qwen|openai)-/i, "").replace(/-(local|cloud)$/i, "");
    return normalized
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  };
  const withdrawnProviders: CBGroup[] = configuredProviders
    .filter((provider) => !overlayProviders.some((candidate) => candidate.cluster === provider.name))
    .map((provider) => {
      const locality = String(provider.name).match(/(east|west|central)/i)?.[1]?.toLowerCase() || "local";
      return { site: `${locality}-local`, cluster: provider.name, group: null, admission: null, tier: "withdrawn", external: false, provider: "local", withdrawn: true };
    });
  const displayProviders = [...overlayProviders, ...withdrawnProviders];
  const gateways = Object.values(displayProviders.reduce<Record<string, { id: string; site: string; candidates: CBGroup[] }>>((all, candidate) => {
    // The overlay has one candidate per backend route. For the symmetric
    // topology, openai-west/openai-central/openai-east share the physical
    // west/central/east provider gateway with their local vLLM candidates.
    // `site` identifies the physical provider-gateway locality. Candidate
    // cluster names identify backends (for example qwen35-east or local-east)
    // and must not create additional gateway boxes.
    const gatewaySite = (candidate.site || candidate.gateway || candidate.routing_cluster || candidate.cluster || "provider-gateway")
      .replace(/^(qwen|openai)-/i, "")
      .replace(/-(local|cloud)$/i, "");
    const id = gatewaySite.toLowerCase();
    const gateway = all[id] || { id, site: gatewaySite, candidates: [] };
    gateway.candidates.push(candidate);
    all[id] = gateway;
    return all;
  }, {}));
  const external = s.external_target || "api.openai.com";
  const pct = Math.round(pressure * 100);

  // colors
  const RED = "#e11", GREEN = "#1f9d55", MUTE = "#8a8d90", AMBER = "#d98200";
  const gaugeColor = pressure >= ENTER ? RED : pressure >= 0.5 ? AMBER : GREEN;
  const money = (micros: number | null | undefined) => micros == null ? "—" : `$${(micros / 1_000_000).toFixed(6)}`;
  const observedUsage = cost?.telemetry_quality === "token-type usage observed";
  const totalHits = (cost?.local_hits || 0) + (cost?.cloud_hits || 0);
  const cloudShare = totalHits ? Math.round(((cost?.cloud_hits || 0) / totalHits) * 100) : 0;

  return (
    <section className="panel cloud-burst-panel" aria-label="Cloud-burst routing and pressure">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Opt-in provider-gateway cloud burst</span>
          <h2>Provider-gateway routing with cloud burst</h2>
          <p>Load on the local provider gateway raises the llm-d EPP queue; sustained pressure flips
             admission to <code>existingOnly</code> and new requests burst through the OpenAI provider gateway at {external}.</p>
        </div>
        <span className={`cb-badge ${burst ? "cb-burst" : pressureActive ? "cb-pressure" : "cb-local"}`}>
          {burst ? "CLOUD BURST ACTIVE" : pressureActive ? "PRESSURE ACTIVE · CLOUD STANDBY" : "LOCAL"}
        </span>
      </div>

      <div className="cb-controls">
        <label className="cb-mode" title="Backend sensitivity: a real GPU saturates and bursts on far less queue than the kind mock.">
          <span>Backend</span>
          <select value={activeMode} disabled={busy}
            onChange={(e) => changeMode(e.target.value)}>
            {Object.entries(modes).length
              ? Object.entries(modes).map(([k, m]) => (
                  <option key={k} value={k}>{m.label} · cap {m.capacity} · {m.replicas} gen</option>
                ))
              : <option value="sim">Simulation (kind)</option>}
          </select>
        </label>
        <button className={`primary-button ${pressureRunning ? "cb-load-on" : ""}`} disabled={busy} onClick={() => pressureRunning ? applyLoad(false, activeMode) : applyLoad(true, activeMode)}>
          {pressureRunning ? (isGpu ? "◼ Stop GPU pressure" : "◼ Stop queue pressure") : isGpu ? "▶ Create GPU pressure" : "▶ Simulate queue pressure"}
        </button>
        <button className="secondary-button" disabled={busy} onClick={stopAllPressure}>■ Stop all pressure</button>
        <div className="cb-metric"><span>Admission</span>
          <strong className={burst ? "cb-txt-red" : "cb-txt-green"}>
            {(s.local_admission || "—").replace(/_/g, " ")}
          </strong>
        </div>
        <div className="cb-metric"><span>EPP queue</span>
          <strong>{queue == null ? "—" : queue.toFixed(1)} / {cap}</strong>
        </div>
        <div className="cb-metric"><span>Load</span>
          <strong>{s.load_on ? `on · ${s.load_replicas} gen` : "off"}</strong>
        </div>
      </div>
      {controlError && <p className="cb-control-error" role="alert">Cloud-burst control unavailable: {controlError}. The panel is showing observed routing state only.</p>}

      <section className="cb-interactive-controls" aria-label="Interactive cloud burst controls">
        <div className="cb-section-heading"><div><span className="eyebrow">Interactive operator controls</span><strong>{isGpu ? "Create sustained pressure and observe the accepted overlay" : "Set queue metrics and observe the accepted overlay"}</strong></div>{!isGpu && <button className="secondary-button" disabled={busy} onClick={resetMetrics}>Reset metrics</button>}</div>
        {isGpu ? <p className="cb-control-note">Real GPU mode uses sustained requests and observed vLLM queue metrics. Static metric sliders are disabled for this backend.</p> : <div className="cb-provider-controls">
          {localProviders.map(({ key: provider, name }) => {
            // The applied depth reflects the optimistic value while a write is
            // pending, otherwise the live server value.
            const applied = localMetrics[provider] ?? s.controls?.metrics?.[provider] ?? 0;
            // The slider shows the staged draft (or the applied value until the
            // operator moves it). Nothing is written until Set is clicked.
            const draft = sliderDraft[provider] ?? applied;
            const dirty = draft !== applied;
            const pending = Boolean(metricBusy[provider]);
            const health = s.controls?.health?.[provider] || "healthy";
            return <label className="cb-provider-slider" key={provider}>
              <span><strong>{name}</strong><output>{draft} waiting{dirty ? ` (applied ${applied})` : ""}</output></span>
              <input aria-label={`Provider ${provider.toUpperCase()} queue metric`} type="range" min="0" max="10" step="5" value={draft} onChange={(event) => setSliderDraft((current) => ({ ...current, [provider]: Number(event.target.value) }))} />
              <small>{pending ? "setting…" : health} · enter above 8.5 / 10</small>
              <div className="cb-provider-slider-actions">
                <button className="primary-button" disabled={pending || !dirty} onClick={() => applyMetric(provider, draft)}>{pending ? "Setting…" : "Set"}</button>
                <button className="secondary-button" disabled={busy} onClick={() => setHealth(provider, health === "healthy" ? "unhealthy" : "healthy")}>{health === "healthy" ? "Mark unhealthy" : "Restore healthy"}</button>
              </div>
            </label>;
          })}
        </div>}
        <div className="cb-gauge" title={`GPU/provider queue pressure ${pct}%`} aria-label={`GPU/provider queue pressure ${pct}%`}>
          <div className="cb-gauge-fill" style={{ width: `${pct}%`, background: gaugeColor }} />
          <div className="cb-gauge-enter" style={{ left: `${ENTER * 100}%` }} title="burst threshold 85%" />
          <span className="cb-gauge-label">GPU/provider queue pressure {pct}% · burst threshold {Math.round(ENTER * 100)}%</span>
        </div>
        <div className="cb-scenario-controls">
          <label>Scenario <select aria-label="Cloud burst scenario" value={tourIndex} onChange={(event) => setTourIndex(Number(event.target.value))}>{tour.map(([title], index) => <option key={title} value={index}>{title}</option>)}</select></label>
          <button className="secondary-button" disabled={busy} onClick={() => runScenario(["baseline", "partial", "progressive", "full", "recovery", "reweight_60_30_10", "full", "recovery"][tourIndex])}>Run selected</button>
          <button className="secondary-button" disabled={busy} onClick={() => { const next = (tourIndex + 1) % tour.length; setTourIndex(next); runScenario(["baseline", "partial", "progressive", "full", "recovery", "reweight_60_30_10", "full", "recovery"][next]); }}>Next guided step</button>
          <span className="cb-tour-copy"><strong>{tour[tourIndex][0]}</strong> · {tour[tourIndex][1]}</span>
        </div>
        <div className="cb-weight-controls">
          <span><strong>Local traffic weights</strong> · publish without restart</span>
          {localKeys.map((provider) => <label key={provider}> {provider.toUpperCase()} <input aria-label={`Weight ${provider}`} type="number" min="1" max="1000" value={weights[provider as keyof typeof weights]} onChange={(event) => setWeights({ ...weights, [provider]: Number(event.target.value) })} /></label>)}
          <button className="secondary-button" disabled={busy} onClick={publishWeights}>Publish weights</button>
        </div>
        <div className="cb-allocation-controls">
          <div><strong>Token allocation governance</strong><small>Shared ledger state is not reset by a policy change.</small></div>
          <span className="cb-allocation-status">{s.controls?.allocation?.enforcement || "soft"} · {s.controls?.allocation?.limit ?? "not configured"} · rev {s.controls?.allocation?.revision ?? 0} · {s.controls?.allocation?.verified ? "verified" : "verification pending"}</span>
          <label>Allocation limit <input aria-label="Allocation limit" type="number" min="1" max="1000000" value={allocationLimit} onChange={(event) => setAllocationLimit(Number(event.target.value))} /></label>
          <button className="secondary-button" disabled={busy} onClick={() => setAllocation("soft")}>Soft observe</button>
          <button className="secondary-button" disabled={busy} onClick={() => setAllocation("hard")}>Hard deny</button>
          <button className="secondary-button" disabled={busy} onClick={() => { const next = 15000; setAllocationLimit(next); setAllocation("soft", next); }}>Raise to 15k</button>
        </div>
      </section>

      <section className="cb-provider-disable" aria-label="Simulator failover controls">
        <div className="cb-section-heading">
          <div><span className="eyebrow">Provider failover</span><strong>Disable a local vLLM simulator</strong></div>
          <span className="cb-control-note">Uses the simulator Deployment and normal Grid health reconciliation.</span>
        </div>
        <p className="cb-control-note">Disable removes the selected simulator’s endpoints so Grid withdraws it from new traffic. Enable restores one replica. This is a real failover test; it does not edit the accepted overlay.</p>
        <div className="cb-disable-grid">
          {localProviders.map(({ key, name, simulator }) => {
            const disabled = Boolean(s.controls?.disabled?.[key]);
            const health = s.controls?.health?.[key] || "healthy";
            return <div className={`cb-disable-card ${disabled || health === "unhealthy" ? "cb-disable-card-off" : ""}`} key={key}>
              <div><strong>{name}</strong><small>{simulator} · {disabled ? "disabled" : health}</small></div>
              <button className="secondary-button" disabled={Boolean(providerBusy[key])} onClick={() => setProviderDisabled(key, !disabled)}>{providerBusy[key] ? "Updating…" : disabled ? "Restore vLLM" : "Disable vLLM"}</button>
            </div>;
          })}
        </div>
      </section>

      {/* topology: client -> consumers -> N provider gateways -> per-gateway vLLM + OpenAI backends.
          One backend row per candidate (no overlap); colored by real group: same-site local = active,
          Active routes are green; unavailable or non-admitting routes are red. */}
      {(() => {
        const TOP = 24, ROW_H = 70, NODE_H = 56;
        let row = 0;
        const laid = gateways.map((gateway) => {
          const children = gateway.candidates
            .slice()
            .sort((a, b) => a.group - b.group || Number(a.external) - Number(b.external))
            .map((candidate) => ({ candidate, y: TOP + row++ * ROW_H }));
          const gwY = children.length
            ? (children[0].y + children[children.length - 1].y) / 2
            : TOP + row++ * ROW_H;
          return { gateway, children, gwY };
        });
        const height = Math.max(300, TOP + row * ROW_H + 24);
        const midY = height / 2;
        const clientY = midY - NODE_H / 2, aY = midY - NODE_H / 2 - 62, bY = midY - NODE_H / 2 + 62;
        return (
          <svg className="cb-topo" viewBox={`0 0 1120 ${height}`} role="img" aria-label="live provider gateway topology">
            <Edge x1={120} y1={clientY + 28} x2={210} y2={aY + 28} color={MUTE} />
            <Edge x1={120} y1={clientY + 28} x2={210} y2={bY + 28} color={MUTE} />
            <Node x={40} y={clientY} w={80} label="Client" sub="requests" />
            <Node x={210} y={aY} w={120} label="Consumer East" sub="quota + route" />
            <Node x={210} y={bY} w={120} label="Consumer West" sub="quota + route" />
            {laid.map(({ gateway, children, gwY }) => {
              const gatewayActive = gateway.candidates.some((c) => !disabledProviderNames.has(c.cluster) && c.admission === "new_and_existing" && c.fresh !== false);
              const gatewayPressure = !gatewayActive && gateway.candidates.some((c) => !disabledProviderNames.has(c.cluster) && c.admission === "existing_only");
              const eligible = gateway.candidates.some((c) => !disabledProviderNames.has(c.cluster) && c.admission === "new_and_existing");
              const gwTone = gatewayActive ? "active" : gatewayPressure ? "pressure" : "unavailable";
              const gwColor = gatewayActive ? GREEN : gatewayPressure ? AMBER : RED;
              return (
                <React.Fragment key={gateway.id}>
                  <Edge x1={330} y1={aY + 28} x2={480} y2={gwY + 28} color={gwColor} />
                  <Edge x1={330} y1={bY + 28} x2={480} y2={gwY + 28} color={gwColor} />
                  <Node x={480} y={gwY} w={190} label={`${gatewayDisplayName(gateway.site)} provider gateway`}
                    sub={`${gateway.candidates.map((c) => c.group == null ? "withdrawn" : `g${c.group}`).join(" / ")} · ${gatewayActive ? (eligible ? "accepting new" : "active") : "not accepting connections"}`}
                    tone={gwTone} />
                  {children.map(({ candidate, y }) => {
                    const candidateDisabled = !candidate.external && disabledProviderNames.has(candidate.cluster);
                    const candidateWithdrawn = Boolean(candidate.withdrawn);
                    const candidateActive = !candidateDisabled && candidate.admission === "new_and_existing" && candidate.fresh !== false;
                    const candidatePressure = !candidateDisabled && candidate.admission === "existing_only";
                    const edgeColor = candidateDisabled ? RED : candidateActive ? GREEN : candidatePressure ? AMBER : RED;
                    const nodeTone = candidateDisabled || (!candidateActive && !candidatePressure) ? "unavailable" : candidatePressure ? "pressure" : "active";
                    const detail = candidate.external ? "overflow" : (candidate.tier === "same_site" ? "local" : String(candidate.tier || "").replace(/_/g, " "));
                    const providerLabel = String(candidate.provider || "external")
                      .replace(/[_-]+/g, " ")
                      .replace(/\b\w/g, (letter) => letter.toUpperCase());
                    return (
                      <React.Fragment key={`${gateway.id}-${candidate.cluster}`}>
                        <Edge x1={670} y1={gwY + 28} x2={800} y2={y + 28} color={edgeColor} dashed={candidateDisabled || candidateWithdrawn} />
                        <Node x={800} y={y} w={280}
                          label={candidate.external ? `${providerLabel} route` : "vLLM backend"}
                          sub={`${candidate.cluster} · ${candidate.group == null ? "withdrawn" : `g${candidate.group}`} · ${candidateDisabled ? "endpoint unavailable" : candidateWithdrawn ? "recovering · awaiting overlay" : candidateActive ? "accepting new" : candidatePressure ? "pressure · existing only" : "not accepting connections"} · ${detail}`}
                          tone={nodeTone} />
                      </React.Fragment>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </svg>
        );
      })()}

      <section className="cb-cost" aria-label="Cloud burst cost and routing evidence">
        <div className="cb-section-heading">
          <div><span className="eyebrow">Observed burst economics</span><strong>Cost follows admitted traffic</strong></div>
          <span className={`cb-data-quality ${observedUsage ? "cb-quality-live" : "cb-quality-muted"}`}>
            {observedUsage ? "TOKEN-TYPE USAGE LIVE" : "TOKEN-TYPE USAGE NOT EXPOSED"}
          </span>
        </div>
        <div className="cb-cost-grid">
          <Metric label="Local hits" value={cost ? String(cost.local_hits ?? 0) : "—"} />
          <Metric label="Cloud hits" value={cost ? String(cost.cloud_hits ?? 0) : "—"} />
          <Metric label="Cloud share" value={cost ? `${cloudShare}%` : "—"} />
          <Metric label="Cloud spend" value={observedUsage ? money(cost?.cloud_cost_micros) : "—"} />
          <Metric label="Cloud tokens" value={observedUsage ? `${cost?.cloud_input_tokens ?? 0} in / ${cost?.cloud_output_tokens ?? 0} out` : "—"} />
          <Metric label="Saved vs all-cloud" value={observedUsage ? money(cost?.saved_vs_all_cloud_micros) : "—"} />
        </div>
        <div className="cb-cost-bar" aria-label={`Local ${100 - cloudShare} percent, cloud ${cloudShare} percent`}>
          <span style={{ width: `${100 - cloudShare}%`, background: GREEN }} />
          <span style={{ width: `${cloudShare}%`, background: RED }} />
        </div>
        {cost?.timeline?.length ? <div className="cb-timeline" aria-label="Burst timeline">
          {cost.timeline.slice(-12).map((bucket) => {
            const max = Math.max(1, bucket.local_hits + bucket.cloud_hits);
            return <div className="cb-time-bucket" key={bucket.at} title={`${new Date(bucket.at).toLocaleTimeString()} · local ${bucket.local_hits} · cloud ${bucket.cloud_hits}`}>
              <span className="cb-time-local" style={{ height: `${(bucket.local_hits / max) * 100}%` }} />
              <span className="cb-time-cloud" style={{ height: `${(bucket.cloud_hits / max) * 100}%` }} />
            </div>;
          })}
        </div> : null}
        <div className="cb-cost-footnote">
          <span>{cost?.source || "Waiting for observed routing data"}</span>
          <span>pricing revision: {cost?.pricing?.revision || "—"}</span>
        </div>
        {cost?.limitations?.map((limitation) => <p className="cb-cost-limitation" key={limitation}>{limitation}</p>)}
        {cost?.recent_cloud_hits?.length ? <div className="cb-hit-feed">
          <strong>Recent cloud hits</strong>
          {cost.recent_cloud_hits.slice(0, 5).map((hit, index) => <span key={`${hit.at}-${index}`}>
            {new Date(hit.at).toLocaleTimeString()} · {hit.input_tokens} in / {hit.output_tokens} out · {money(hit.cost_micros)}{hit.trace_id ? ` · ${hit.trace_id.slice(0, 12)}` : ""}
          </span>)}
        </div> : null}
      </section>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="cb-cost-metric"><span>{label}</span><strong>{value}</strong></div>;
}

function Node({ x, y, w, label, sub, tone = "muted" }:
  { x: number; y: number; w: number; label: string; sub?: string; tone?: string }) {
  return (
    <g className={`cb-node cb-${tone}`}>
      <rect x={x} y={y} width={w} height={56} rx={8} />
      <text x={x + w / 2} y={y + 24} textAnchor="middle" className="cb-node-label">{label}</text>
      {sub && <text x={x + w / 2} y={y + 42} textAnchor="middle" className="cb-node-sub">{sub}</text>}
    </g>
  );
}

function Edge({ x1, y1, x2, y2, color, label, dashed }:
  { x1: number; y1: number; x2: number; y2: number; color: string; label?: string; dashed?: boolean }) {
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  return (
    <g>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={2.5} strokeDasharray={dashed ? "7 5" : undefined} opacity={dashed ? 0.85 : 1} />
      {label && <text x={mx} y={my - 6} textAnchor="middle" className="cb-edge-label" fill={color}>{label}</text>}
    </g>
  );
}
