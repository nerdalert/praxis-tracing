import { useCallback, useEffect, useMemo, useState } from "react";

const formatRevision = (value) => {
  const text = String(value || "UNAVAILABLE");
  return text.length > 20 ? `${text.slice(0, 12)}…${text.slice(-6)}` : text;
};

const short = (value, limit = 18) => {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text || "UNAVAILABLE";
};

const formatAge = (seconds) => {
  if (!Number.isFinite(seconds)) return "age unavailable";
  return seconds < 10 ? `${seconds.toFixed(1)}s old` : `${Math.round(seconds)}s old`;
};

const formatTime = (value) => value ? new Date(value).toLocaleTimeString() : "time unavailable";

const statusTone = (status) => {
  if (["LIVE", "READY", "recovered", "restored"].includes(status)) return "live";
  if (["STALE", "starting", "applied", "recovering", "interrupting", "restoring"].includes(status)) return "simulation";
  return "unknown";
};

const poolDisplayName = (poolId) => ({
  "pool-a": "Dynamo · Pool A",
  "pool-b": "Dynamo · Pool B",
  "site-pool": "Dynamo · Remote Pool",
})[poolId] || `Dynamo · ${poolId || "Pool unavailable"}`;

const modelReadiness = (metric) => {
  if (metric?.status !== "LIVE") return metric?.status || "UNAVAILABLE";
  if (metric.value === 1) return "READY";
  if (metric.value === 0) return "NOT READY";
  return "UNAVAILABLE";
};

const pressureLabel = (phase) => ({
  idle: "BASELINE",
  starting: "APPLYING PRESSURE",
  applied: "PRESSURE OBSERVED",
  recovering: "RECOVERING",
  recovered: "RECOVERED",
  failed: "CHECK SIGNALS",
  "recovery-pending": "RECOVERY PENDING",
  "interruption-pending": "SIGNAL CHECK PENDING",
})[phase] || "BASELINE";

function Badge({ children, tone = "unknown", id, testId }) {
  return <span id={id} className={`badge badge-${tone}`} data-testid={testId}>{children}</span>;
}

function candidateRows(candidates, pools, live) {
  return candidates.map((candidate) => {
    const pool = pools.find((item) => item.id === candidate.cluster);
    const fresh = live && candidate.fresh === true;
    return {
      ...candidate,
      label: `${poolDisplayName(candidate.cluster)} · ${candidate.site || "Unknown site"}`,
      fresh,
    };
  });
}

function DynamoDashboard() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState("Connecting to live Dynamo Frontends and Grid status…");
  const [error, setError] = useState("");
  const [sampleCount, setSampleCount] = useState(12);
  const [counterBaselines, setCounterBaselines] = useState(null);
  const [counterResetAt, setCounterResetAt] = useState(null);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error(`Live state returned HTTP ${response.status}`);
    const next = await response.json();
    setState(next);
    setError("");
    return next;
  }, []);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const response = await fetch("/api/state", { cache: "no-store" });
        if (!response.ok) throw new Error("Live state endpoint is unavailable");
        const next = await response.json();
        if (active) {
          setState(next);
          setError("");
        }
      } catch (cause) {
        if (active) {
          setError(cause instanceof Error ? cause.message : "Live state is unavailable");
          setActionMessage("UNAVAILABLE · no healthy zero or live candidate values are assumed.");
        }
      }
    };
    void poll();
    const timer = window.setInterval(poll, 1200);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const perform = useCallback(async (endpoint, message, confirmText = "", requestBody = {}) => {
    if (busy) return;
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setActionMessage(message);
    setError("");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Action returned HTTP ${response.status}`);
      if (payload?.state?.pools) setState(payload.state);
      else if (payload?.pools) setState(payload);
      await refresh();
    } catch (cause) {
      const messageText = cause instanceof Error ? cause.message : "Action failed";
      setError(messageText);
      setActionMessage(`ACTION FAILED · ${messageText}`);
    } finally {
      setBusy(false);
      await refresh().catch(() => {});
    }
  }, [busy, refresh]);

  const pools = state?.pools || [];
  const poolA = pools.find((item) => item.id === "pool-a");
  const localCandidates = state?.overlay?.published?.candidates || [];
  const published = state?.overlay?.published || { status: "UNAVAILABLE" };
  const consumed = state?.overlay?.consumed || { status: "UNAVAILABLE" };
  const overlayConverged = published.status === "LIVE" && consumed.status === "LIVE" && state?.overlay?.converged === true;
  const sourceCount = pools.filter((pool) => pool.source?.status === "LIVE").length;
  const readyCount = pools.filter((pool) => modelReadiness(pool.modelReady) === "READY").length;
  const allLive = pools.length === 3 && sourceCount === 3 && published.status === "LIVE" && consumed.status === "LIVE";
  const rankRows = useMemo(() => candidateRows(localCandidates, pools, published.status === "LIVE"), [localCandidates, pools, published.status]);
  const localProbe = [...(state?.probes || [])].reverse().find((probe) => probe.kind === "local");
  const localSelected = localProbe?.routingEvidence?.gatewayRequestDelta?.status === "LIVE" &&
    localProbe?.routingEvidence?.gatewayRequestDelta?.total === 1
    ? localProbe.routingEvidence.gatewayRequestDelta.selectedBackend
    : null;
  const pressurePhase = state?.pressure?.phase || "idle";
  const pressureRunsByPool = state?.pressure?.runsByPool || {};
  const pressureRunFor = (poolId) => pressureRunsByPool[poolId] || { phase: "idle", target: { id: poolId } };
  const activePressureIds = pools.filter((pool) => pressureRunFor(pool.id).phase === "applied").map((pool) => pool.id);
  const poolAActiveMetricReady = poolA?.activeRequests?.status === "LIVE" && Number.isFinite(poolA.activeRequests.value);
  const poolACapacityReady = Number.isSafeInteger(poolA?.capacity) && poolA.capacity > 0;
  const poolAProfileReady = typeof poolA?.profile === "string" && poolA.profile.length > 0;
  const localProbeReady = modelReadiness(poolA?.modelReady) === "READY" && poolAActiveMetricReady && poolACapacityReady && poolAProfileReady && overlayConverged;
  const pressureActionsPending = pools.some((pool) => ["starting", "recovering", "recovery-pending", "failed"].includes(pressureRunFor(pool.id).phase));
  const pressureBusy = pools.some((pool) => ["starting", "recovering", "recovery-pending"].includes(pressureRunFor(pool.id).phase));

  const freshCandidate = (candidate) => candidate?.scoreStatus === "LIVE" && Number.isFinite(candidate.score) &&
    Number.isFinite(candidate.sampleAgeSeconds) && Number.isFinite(state?.gatewayMetrics?.crossSite?.freshnessWindowMs) &&
    candidate.sampleAgeSeconds <= state.gatewayMetrics.crossSite.freshnessWindowMs / 1000;
  const peerMetrics = state?.gatewayMetrics?.crossSite || {};
  const peerCandidates = peerMetrics.candidates || [];
  const candidateWindow = Number.isFinite(peerMetrics.freshnessWindowMs) ? peerMetrics.freshnessWindowMs / 1000 : null;
  const freshPeerCount = peerCandidates.filter(freshCandidate).length;
  const peerSnapshotFresh = peerCandidates.length === 3 && freshPeerCount === 3;
  const peerHasFresh = freshPeerCount > 0;
  const peerCandidateStatus = peerMetrics.status !== "LIVE" ? peerMetrics.status : peerSnapshotFresh ? "LIVE" : peerHasFresh ? "STALE" : "UNAVAILABLE";
  const peer = state?.peer || {};
  const interruption = state?.interruption || {};
  const signalCondition = peer.status === "LIVE" && peer.signals?.status === "LIVE"
    ? (peer.signals.value ? "LIVE" : "INTERRUPTED")
    : peer.status === "STALE" ? "STALE" : "UNAVAILABLE";
  const sitePoolSite = pools.find((pool) => pool.id === "site-pool")?.site;
  const localSite = poolA?.site;
  const localPeerCandidates = peerCandidates.filter((candidate) => candidate.site === localSite);
  const remoteCandidate = peerCandidates.find((candidate) => candidate.cluster === "site-pool" && candidate.site === sitePoolSite);
  const signalUnavailableAt = peer.signals?.value === false ? Date.parse(peer.signals.observedAt) : NaN;
  const outageAgeSeconds = Number.isFinite(signalUnavailableAt) ? (Date.now() - signalUnavailableAt) / 1000 : null;
  const hubScoresExpired = localPeerCandidates.length === 2 && localPeerCandidates.every((candidate) => candidate.scoreStatus === "UNAVAILABLE" && !Number.isFinite(candidate.score));
  const hubSamplesExpired = hubScoresExpired && Number.isFinite(candidateWindow) && Number.isFinite(outageAgeSeconds) && outageAgeSeconds > candidateWindow + 5;
  const fallbackReady = freshCandidate(remoteCandidate) && hubSamplesExpired;
  const restoredRouteReady = signalCondition === "LIVE" && peerSnapshotFresh;
  const peerProbeReady = interruption.phase === "interrupted" ? fallbackReady : restoredRouteReady;
  const hasInterruption = ["interrupted", "interrupting", "interruption-pending"].includes(interruption.phase);
  const peerProbeLabel = interruption.phase === "interrupted" ? "Probe local fallback" : interruption.phase === "restored" ? "Probe restored route" : "Probe cross-site route";
  const traffic = state?.traffic || { status: "UNAVAILABLE", phase: "unavailable", running: false, countsByPool: {}, results: [] };
  const trafficRunning = traffic.running === true;
  const pressureResetAvailable = pools.some((pool) =>
    ["starting", "applied", "recovering", "recovery-pending", "failed"].includes(pressureRunFor(pool.id).phase));
  const siteRouteMetricsReady = peerMetrics.status === "LIVE" && peer.status === "LIVE" &&
    peer.signals?.status === "LIVE" && peer.signals.value === true && peerSnapshotFresh &&
    peerCandidates.every((candidate) => Number.isFinite(candidate.rho));
  const pressureTargetId = state?.pressure?.target?.id || state?.pressure?.activeTargets?.at(-1) || "pool-a";
  const pressurePool = pools.find((pool) => pool.id === pressureTargetId);
  const pressureCapacityReady = Number.isSafeInteger(pressurePool?.capacity) && pressurePool.capacity > 0;
  const localCandidateSetReady = overlayConverged && rankRows.filter((candidate) => ["pool-a", "pool-b"].includes(candidate.cluster)).length === 2 &&
    rankRows.filter((candidate) => ["pool-a", "pool-b"].includes(candidate.cluster)).every((candidate) => candidate.fresh && Number.isInteger(candidate.rank));
  const canApplyPressure = (targetPool) => {
    const run = pressureRunFor(targetPool?.id);
    const active = targetPool?.activeRequests;
    const targetIsIdle = active?.status === "LIVE" && active.value === 0;
    const targetCandidate = targetPool?.id === "site-pool"
      ? peerCandidates.find((candidate) => candidate.cluster === targetPool.id)
      : localCandidates.find((candidate) => candidate.cluster === targetPool?.id);
    const routeReady = targetPool?.id === "site-pool"
      ? siteRouteMetricsReady && freshCandidate(targetCandidate) && Number.isInteger(targetCandidate?.scoreOrder)
      : localCandidateSetReady;
    const otherActionPending = pools.some((pool) => pool.id !== targetPool?.id &&
      ["starting", "recovering", "recovery-pending", "failed"].includes(pressureRunFor(pool.id).phase));
    return ["idle", "recovered"].includes(run.phase) && modelReadiness(targetPool?.modelReady) === "READY" &&
      targetIsIdle && Number.isSafeInteger(targetPool?.capacity) && targetPool.capacity > 0 &&
      typeof targetPool?.profile === "string" && targetPool.profile.length > 0 && routeReady &&
      !otherActionPending && !trafficRunning && !busy && !hasInterruption;
  };
  const siteGatewaySeesPressure = (poolId) => {
    const targetPool = pools.find((pool) => pool.id === poolId);
    const candidate = peerCandidates.find((item) => item.cluster === poolId);
    return targetPool?.activeRequests?.status === "LIVE" && Number.isSafeInteger(targetPool.capacity) &&
      targetPool.activeRequests.value >= targetPool.capacity && freshCandidate(candidate) &&
      Number.isFinite(candidate?.rho) && candidate.rho >= 1;
  };
  const siteGatewaySeesAllPressure = activePressureIds.every(siteGatewaySeesPressure);
  const trafficCanStart = siteRouteMetricsReady && !trafficRunning && !busy && !pressureBusy && !pressureActionsPending &&
    !hasInterruption && (activePressureIds.length === 0 || siteGatewaySeesAllPressure);
  const trafficMessage = !siteRouteMetricsReady
    ? "WAITING · Site Gateway needs a fresh three-pool snapshot and reachable peer signals."
    : activePressureIds.length > 0 && !siteGatewaySeesAllPressure
      ? `WAITING · Site Gateway has not yet observed every pressured pool at its configured Grid comparison reference; no sample can start.`
      : trafficRunning
        ? `GENERATING · ${traffic.completed}/${traffic.requested} requests completed; pool counts use emitted Site Gateway site/backend attribution.`
        : traffic.phase === "completed"
          ? `SAMPLE COMPLETE · ${traffic.succeeded} valid responses · ${traffic.attributed} attributed to a pool · ${traffic.unattributed} without a verified pool.`
          : traffic.phase === "stopped"
            ? `STOPPED · ${traffic.completed}/${traffic.requested} completed; partial route counts remain visible.`
            : "READY · the Site Gateway GridSiteRoute reaches all three pools.";
  const siteGatewayRequestCount = (poolId) => {
    const requests = peerMetrics.requests;
    if (peerMetrics.status !== "LIVE" || requests?.status !== "LIVE" || !Number.isFinite(peerMetrics.ageSeconds) || peerMetrics.ageSeconds > 5) return null;
    const matches = (requests.counts || []).filter((item) => item.cluster === poolId);
    if (!matches.length || matches.some((item) => !Number.isFinite(item.value) || item.value < 0)) return null;
    return matches.reduce((sum, item) => sum + item.value, 0);
  };
  const liveRequestCounters = Object.fromEntries(pools.map((pool) => [pool.id, siteGatewayRequestCount(pool.id)]));
  const displayedRequestCount = (poolId) => {
    const current = liveRequestCounters[poolId];
    const baseline = counterBaselines?.[poolId];
    if (!Number.isSafeInteger(current) || !Number.isSafeInteger(baseline) || current < baseline) return null;
    return current - baseline;
  };
  const countersReady = ["pool-a", "pool-b", "site-pool"].every((id) => Number.isSafeInteger(liveRequestCounters[id]));
  useEffect(() => {
    if (!counterBaselines && countersReady) setCounterBaselines(liveRequestCounters);
  }, [counterBaselines, countersReady, liveRequestCounters["pool-a"], liveRequestCounters["pool-b"], liveRequestCounters["site-pool"]]);
  const resetDisplayedCounters = () => {
    if (!countersReady) return;
    setCounterBaselines(liveRequestCounters);
    setCounterResetAt(new Date().toISOString());
  };

  const history = (state?.history || []).filter((sample) => sample.activeByPool?.[pressureTargetId]?.status === "LIVE" && Number.isFinite(sample.activeByPool[pressureTargetId].value)).slice(-48);
  const chartCapacity = pressureCapacityReady ? pressurePool.capacity : null;
  const chartMax = Math.max(chartCapacity || 1, ...history.map((sample) => sample.activeByPool[pressureTargetId].value));
  const chartPoints = history.map((sample, index) => {
    const x = history.length < 2 ? 360 : (index / (history.length - 1)) * 720;
    const y = 88 - Math.min(1, sample.activeByPool[pressureTargetId].value / chartMax) * 76;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const latestSample = history.at(-1);

  const actionState = () => {
    if (!state) return "Waiting for live Frontend metrics…";
    if (busy) return "Action in progress. Waiting on fresh runtime evidence…";
    if (pressurePhase === "failed") return "Pressure did not satisfy the live proof gate. Recover each flagged pool before retrying.";
    if (pressureActionsPending) return "Applying or recovering pool pressure. Wait for fresh Frontend metrics and the relevant Grid route view before sampling traffic.";
    if (activePressureIds.length > 0) {
      const names = activePressureIds.map(poolDisplayName).join(" + ");
      const localPressure = activePressureIds.some((id) => id === "pool-a" || id === "pool-b");
      return `LIVE pressure · ${names}. Site Gateway pressure is ${siteGatewaySeesAllPressure ? "observed" : "waiting"}; the local overlay is ${localPressure ? (overlayConverged ? "converged" : "still converging") : "separate"}.`;
    }
    if (pressurePhase === "recovered") return `Recovered · ${poolDisplayName(pressureTargetId)} active_requests is freshly zero and its route view is live again. Compare the next generated request sample.`;
    return "Baseline data is loading from the live pools and Grid Gateway.";
  };

  const generatedRows = (traffic.results || []).map((request) => ({
    ...request, id: request.requestId, kind: "sampler", completedAt: request.completedAt,
  }));
  const sortedProbes = [...(state?.probes || []), ...generatedRows]
    .sort((left, right) => Date.parse(right.completedAt || 0) - Date.parse(left.completedAt || 0))
    .slice(0, 24);
  const localCandidatesFresh = published.status === "LIVE" && rankRows.length >= 2 && rankRows.every((candidate) => candidate.fresh);
  const pressureTargetName = poolDisplayName(pressureTargetId);
  const latestActive = latestSample?.activeByPool?.[pressureTargetId]?.value;

  return (
    <div className="app weighted-dashboard dynamo-dashboard">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">G</div>
          <div><h1>Grid · Dynamo Signals</h1><p>Live Frontend signal routing</p></div>
        </div>
        <div className="header-actions">
          <a className="source-identity-link" href="#identityDetails" title="Open exact non-secret runtime identity">GRID {state?.identity?.gridSourceStateSha256 ? state.identity.gridSourceStateSha256.slice(0, 12) : "source unavailable"} · DYNAMO {state?.identity?.dynamoImageId ? state.identity.dynamoImageId.replace(/^sha256:/, "").slice(0, 10) : "image unavailable"}</a>
          <Badge testId="live-badge" tone={allLive ? "live" : "unknown"}>{allLive ? `${readyCount}/${pools.length} POOLS LIVE` : state?.source?.status === "PARTIAL" ? "PARTIAL LIVE SOURCES" : "LIVE SOURCES UNAVAILABLE"}</Badge>
          <Badge tone="source">RUN {state?.runId?.split("-").at(-1) || "—"}</Badge>
        </div>
      </header>

      <main className="dynamo-main">
        <section className="panel demo-guide dynamo-intro">
          <div className="panel-heading compact">
            <div><span className="eyebrow">Live demonstration</span><h2>Signals change where the next request goes.</h2></div>
            <Badge tone="live">Dynamo Frontend adapter</Badge>
          </div>
          <p className="panel-note guide-intro"><strong>Platform engineer view:</strong> actual Dynamo Frontend readiness and active-request gauges feed Grid’s comparable per-pool pressure score. Follow the Hub overlay for local pools or the Site Gateway snapshot for the remote pool, then verify new requests with live counters and emitted route attribution.</p>
          <p className="panel-note"><strong>Demo contract:</strong> Dynamo Mocker returns synthetic inference responses while the Frontend exports real runtime signals. The declared concurrency profile is test configuration; it is not measured GPU capacity. Frontend stage counts do not represent llm-d/EPP queues.</p>
        </section>

        <section className="status-strip dynamo-status-strip" aria-label="Live demo status">
          <div className="status-item"><span className={`status-dot ${sourceCount === pools.length && pools.length ? "normal" : "unknown"}`} /><span>Frontend scrapes</span><strong>{state ? `${sourceCount}/${pools.length || "—"} LIVE` : "UNAVAILABLE"}</strong></div>
          <div className="status-item"><span className={`status-dot ${overlayConverged ? "normal" : "unknown"}`} /><span>Local overlay → Gateway</span><strong>{overlayConverged ? "CONVERGED" : published.status === "LIVE" && consumed.status === "LIVE" ? "UPDATING" : "UNAVAILABLE"}</strong></div>
          <div className="status-item"><span className={`status-dot ${signalCondition === "LIVE" ? "normal" : "unknown"}`} /><span>Peer signal endpoint</span><strong>{signalCondition}</strong></div>
        </section>

        <section className="panel topology-panel">
            <div className="panel-heading compact">
            <div><span className="eyebrow">Two run-owned Kind clusters</span><h2>Two local Dynamo pools, one remote pool</h2><p>Dynamo · Pool A and Dynamo · Pool B are separate Frontend + Mocker Pods in local context kind-grid-sig-demo-hub. Dynamo · Remote Pool runs in remote context kind-grid-sig-demo-site. Hub Gateway consumes the local overlay; Site Gateway consumes the cross-site snapshot.</p></div>
            <Badge tone={overlayConverged ? "live" : "unknown"}>{overlayConverged ? "REVISION CONSUMED" : "REVISION STATUS UNKNOWN"}</Badge>
          </div>
          <div className="topology-canvas dynamo-topology">
            <div className="route-lane local-route-lane">
              <div className="topology-node client"><strong>Client</strong><small>new chat request</small></div>
              <div className="dynamo-arrow" aria-hidden="true">→</div>
              <div className="topology-node consumer"><strong>Hub Gateway</strong><small>consumes {formatRevision(consumed.revision)}</small></div>
              <div className="dynamo-arrow overlay-arrow" aria-hidden="true"><span>Grid overlay</span>→</div>
              <div className="topology-pools">
                {pools.filter((pool) => pool.id !== "site-pool").map((pool) => {
                  const selected = localSelected === pool.id;
                  const rank = localCandidates.find((candidate) => candidate.cluster === pool.id)?.rank;
                  const podName = pool.id === "pool-a" ? "dynamo-pool-a" : "dynamo-pool-b";
                  return <div key={pool.id} className={`topology-node provider ${selected ? "active-provider" : ""}`}>
                    <strong>{poolDisplayName(pool.id)} · {pool.id}{selected ? " · last selected" : ""}</strong>
                    <small>Pod {podName} · rank {localCandidatesFresh && Number.isInteger(rank) ? rank : "UNAVAILABLE"}</small>
                  </div>;
                })}
              </div>
            </div>
            <div className="route-lane peer-route-lane">
              <div className="topology-node peer-signal"><strong>Secure peer signals</strong><small>revisioned Grid site snapshot</small></div>
              <div className="dynamo-arrow peer-arrow" aria-hidden="true">⇢</div>
              <div className="topology-node consumer"><strong>Site Gateway</strong><small>GridSiteRoute snapshot</small></div>
              <div className="dynamo-arrow" aria-hidden="true">→</div>
              <div className={`topology-node provider ${localSelected === "site-pool" ? "active-provider" : ""}`}>
                <strong>Dynamo · Remote Pool · site-pool</strong><small>Pod dynamo-remote-pool · {pools.find((pool) => pool.id === "site-pool")?.site || "UNAVAILABLE"}</small>
              </div>
            </div>
          </div>
          <div className="topology-legend"><span><i className="legend-dot active" />observed last Gateway backend</span><span><i className="legend-dot muted" />configured signal and request paths</span></div>
        </section>

        <section className="section-heading dynamo-section-heading">
          <div><span className="eyebrow">Baseline · two sites · three Dynamo pools</span><h2>Live inference pools</h2><p className="pool-location-note">Dynamo · Pool A and Dynamo · Pool B are independent Frontend + Mocker Pods in the local Kind cluster. Dynamo · Remote Pool runs in the remote Kind cluster.</p></div>
          <div className="pool-heading-actions">
            <span className="muted-text">{state ? `${sourceCount}/${pools.length} live Frontend scrapes · ${formatTime(state.timestamp)}` : "Waiting for fresh Frontend scrapes…"}</span>
            <div className="pool-heading-buttons">
              <button className="secondary-button" type="button" data-testid="reset-counters" disabled={!countersReady || busy} onClick={resetDisplayedCounters}>Reset counters</button>
              <button className="secondary-button warning-button" type="button" data-testid="reset-pressure" title="Release pressure on every pool and wait for route recovery" disabled={busy || !pressureResetAvailable} onClick={() => void perform("/api/pressure/stop", "Releasing direct Mocker pressure on all pools and waiting for fresh zero-active signals and route recovery.")}>Reset pressure</button>
            </div>
            <small data-testid="counter-reset-note">Displayed counts reset locally; Gateway Prometheus counters remain cumulative.{counterResetAt ? ` Last reset ${formatTime(counterResetAt)}.` : " Showing counts since this page connected."}</small>
          </div>
        </section>

        <section className="weighted-grid dynamo-pool-grid" aria-label="Dynamo Frontend pools">
          {pools.map((pool) => {
            const ready = modelReadiness(pool.modelReady);
            const capacityOk = Number.isSafeInteger(pool.capacity) && pool.capacity > 0;
            const activeOk = pool.activeRequests?.status === "LIVE" && Number.isFinite(pool.activeRequests.value) && pool.activeRequests.value >= 0;
            const freshness = pool.source?.status === "LIVE" ? `Frontend /metrics · ${formatAge(pool.source.ageSeconds)}` : `${pool.source?.status || "UNAVAILABLE"} · Frontend /metrics`;
            const isLocal = pool.id !== "site-pool";
            const podName = pool.id === "pool-a" ? "dynamo-pool-a" : pool.id === "pool-b" ? "dynamo-pool-b" : "dynamo-remote-pool";
            const gatewayRequestTotal = displayedRequestCount(pool.id);
            const routedThisSample = ["READY", "LIVE"].includes(traffic.status) && Number.isSafeInteger(traffic.countsByPool?.[pool.id])
              ? traffic.countsByPool[pool.id] : null;
            const pressureRun = pressureRunFor(pool.id);
            const poolPressurePhase = pressureRun.phase || "idle";
            const poolPressureButtonText = poolPressurePhase === "applied" ? "Recover pool"
              : ["starting", "recovering"].includes(poolPressurePhase) ? pressureLabel(poolPressurePhase)
                : poolPressurePhase === "recovery-pending" || poolPressurePhase === "failed" ? "Retry recovery"
                  : "Generate pressure";
            const poolPressureDetails = poolPressurePhase === "applied"
              ? `LIVE · ${activeOk ? `active_requests=${pool.activeRequests.value}` : pool.activeRequests?.status || "UNAVAILABLE"} · Grid comparison reference ${capacityOk ? pool.capacity : "UNAVAILABLE"}`
              : poolPressurePhase === "starting" ? "Applying bounded direct requests; waiting for Frontend and route evidence."
                : ["recovering", "recovery-pending"].includes(poolPressurePhase) ? "Releasing direct requests; waiting for fresh zero and route recovery."
                  : poolPressurePhase === "failed" ? "Pressure proof failed; recover this pool before retrying."
                    : poolPressurePhase === "recovered" ? "RECOVERED · fresh zero-active signal and route view observed."
                      : "READY · direct bounded requests target this pool's Mocker endpoint.";
            const poolPressureBusy = ["starting", "recovering"].includes(poolPressurePhase);
            const poolPressureActionDisabled = busy || trafficRunning || poolPressureBusy || hasInterruption ||
              (!["applied", "failed", "recovery-pending"].includes(poolPressurePhase) && !canApplyPressure(pool));
            return <article className="panel weighted-pool dynamo-pool" key={pool.id} data-testid={`pool-${pool.id}`}>
              <div className="panel-heading compact">
                <div>
                  <span className="eyebrow">{isLocal ? "LOCAL KIND CLUSTER · grid-sig-demo-local-site" : "REMOTE KIND CLUSTER · grid-sig-demo-remote-site"}</span>
                  <h2>{poolDisplayName(pool.id)}</h2>
                  <p>{pool.id} · Pod {podName} · Frontend + Mocker</p>
                </div>
                <Badge tone={statusTone(ready)}>{ready}</Badge>
              </div>
              <div className="dynamo-pool-metrics">
                <div className="pool-metric"><span>model_ready</span><strong>{ready === "READY" ? "1 · READY" : ready === "NOT READY" ? "0 · NOT READY" : `— · ${ready}`}</strong><small>actual Dynamo Frontend gauge</small></div>
                <div className="pool-metric"><span>active_requests</span><strong data-testid={`active-requests-${pool.id}`}>{activeOk ? pool.activeRequests.value : pool.activeRequests?.status || "UNAVAILABLE"}</strong><small>actual Frontend-wide Dynamo gauge</small></div>
                <div className="pool-metric pool-request-counter"><span>Site Gateway requests since reset</span><strong data-testid={`pool-request-counter-${pool.id}`}>{gatewayRequestTotal === null ? "UNAVAILABLE" : gatewayRequestTotal}</strong><small>{routedThisSample === null ? "UNAVAILABLE · no verified sample counts" : `${routedThisSample} routed this sample`}</small></div>
              </div>
              <div className={`pool-pressure-control pool-pressure-${poolPressurePhase}`}>
                <div><strong data-testid={`pool-pressure-state-${pool.id}`}>{pressureLabel(poolPressurePhase)}</strong><small>{poolPressureDetails}</small></div>
                <button className={poolPressurePhase === "applied" ? "secondary-button warning-button" : "primary-button"} type="button" data-testid={`pool-pressure-${pool.id}`} disabled={poolPressureActionDisabled} onClick={() => {
                  if (poolPressurePhase === "applied" || ["failed", "recovery-pending"].includes(poolPressurePhase)) {
                    void perform("/api/pressure/stop", `Releasing pressure only on ${poolDisplayName(pool.id)} and waiting for fresh recovery.`, "", { targetPoolId: pool.id });
                  } else {
                    void perform("/api/pressure/start", `Applying bounded pressure to ${poolDisplayName(pool.id)} and waiting for fresh Frontend and route evidence.`, "", { targetPoolId: pool.id });
                  }
                }}>{poolPressureButtonText}</button>
              </div>
              <dl className="weighted-facts dynamo-facts">
                <div><dt>Comparable profile</dt><dd>{pool.profile || "UNAVAILABLE"}</dd></div>
                <div><dt>Grid comparison reference</dt><dd>{capacityOk ? `${pool.capacity} · configured demo value` : "UNAVAILABLE"}</dd></div>
                <div><dt>Metric source</dt><dd>{freshness}</dd></div>
              </dl>
              <div className="pool-card-footer"><code>{state?.clusters?.[pool.id === "site-pool" ? "site" : "hub"]?.context || "cluster identity unavailable"}</code><span>model {pool.model || "UNAVAILABLE"}</span></div>
            </article>;
          })}
          {!pools.length && <div className="pool-skeleton">Loading actual Frontend /metrics…</div>}
        </section>

        <section className="weighted-lower dynamo-decision-grid">
          <article className="panel dynamo-candidates">
            <div className="panel-heading compact"><div><span className="eyebrow">Hub local overlay · Pool A and Pool B only</span><h2>Candidate score and rank</h2><p data-testid="local-candidate-scope">This Hub overlay ranks Pool A and Pool B only. The Remote Pool has a separate Site Gateway ranking <a className="scope-jump" data-testid="site-ranking-jump" href="#siteGatewayCandidates">below ↓</a>.</p></div><Badge tone={localCandidatesFresh ? "live" : "unknown"}>{localCandidatesFresh ? "LIVE GRID DATA" : published.status}</Badge></div>
            <div className="table-wrap">
              <table className="request-table candidate-table" data-testid="local-candidate-table"><thead><tr><th>Site / pool</th><th>Grid score</th><th>Rank</th><th>Source</th></tr></thead>
                <tbody>{rankRows.filter((candidate) => candidate.cluster !== "site-pool").map((candidate) => <tr key={candidate.cluster} data-testid={`candidate-${candidate.cluster}`}>
                  <td>{candidate.label}</td>
                  <td className="score">{candidate.fresh && Number.isFinite(candidate.score) ? candidate.score.toFixed(3) : "—"}</td>
                  <td>{candidate.fresh && Number.isInteger(candidate.rank) ? <span className="rank-badge">{candidate.rank}</span> : "—"}</td>
                  <td>{candidate.fresh ? "LIVE · current overlay" : published.status}</td>
                </tr>)}
                  {!rankRows.filter((candidate) => candidate.cluster !== "site-pool").length && <tr><td colSpan="4" className="empty-state">{published.status} · no current local candidate data</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="revision-grid">
              <div className="revision-card"><span>Published overlay</span><strong title={published.revision || ""}>{published.status === "LIVE" ? formatRevision(published.revision) : published.status}</strong><small>Grid operator · {formatTime(published.observedAt)}</small></div>
              <div className="revision-card consumed"><span>Consumed by Hub Gateway</span><strong title={consumed.revision || ""}>{consumed.status === "LIVE" ? formatRevision(consumed.revision) : consumed.status}</strong><small>mounted overlay · {formatTime(consumed.observedAt)}</small></div>
            </div>
            <div className={`revision-state state-${overlayConverged ? "live" : published.status === "LIVE" && consumed.status === "LIVE" ? "stale" : "unavailable"}`} data-testid="revision-state">
              {overlayConverged ? "LIVE · published and Gateway-consumed revisions match" : published.status !== "LIVE" || consumed.status !== "LIVE" ? `UNAVAILABLE · published ${published.status} · Gateway consumed ${consumed.status}` : "STALE · published and consumed revisions do not match"}
            </div>
            <section className="site-snapshot-candidates" id="siteGatewayCandidates" aria-label="Site Gateway route snapshot candidates">
              <div className="site-snapshot-heading">
                <div><span className="eyebrow">Site Gateway · cross-site snapshot</span><h3>Candidate score and rank</h3><p>This separate snapshot includes the Remote Pool; it is not part of the Hub local overlay.</p></div>
                <Badge tone={statusTone(peerCandidateStatus)}>{peerCandidateStatus}</Badge>
              </div>
              <div className="table-wrap">
                <table className="request-table candidate-table site-candidate-table" data-testid="site-candidate-table">
                  <thead><tr><th>Site / pool</th><th>Grid score</th><th>Order</th><th>Rho</th><th>Source</th></tr></thead>
                  <tbody>{peerCandidates.map((candidate) => {
                    const fresh = freshCandidate(candidate);
                    const order = fresh && Number.isInteger(candidate.scoreOrder) ? candidate.scoreOrder : null;
                    return <tr key={candidate.cluster} data-testid={`site-candidate-${candidate.cluster}`}>
                      <td>{poolDisplayName(candidate.cluster)} · {candidate.site || "site unavailable"}</td>
                      <td className="score" data-testid={`site-candidate-score-${candidate.cluster}`}>{fresh && Number.isFinite(candidate.score) ? candidate.score.toFixed(3) : "—"}</td>
                      <td data-testid={`site-candidate-order-${candidate.cluster}`}>{order === null ? "—" : order}</td>
                      <td>{fresh && Number.isFinite(candidate.rho) ? candidate.rho.toFixed(2) : "—"}</td>
                      <td>{fresh ? "LIVE · current Site Gateway snapshot" : candidate.scoreStatus === "LIVE" ? "STALE" : candidate.scoreStatus || "UNAVAILABLE"}</td>
                    </tr>;
                  })}
                    {!peerCandidates.length && <tr><td colSpan="5" className="empty-state">{peerCandidateStatus} · no current Site Gateway candidate data</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          </article>

          <article className="panel dynamo-actions">
            <div className="panel-heading compact"><div><span className="eyebrow">Presenter controls</span><h2>Route probes and traffic sampling</h2><p>Start pressure independently from each pool card above. Multiple pool loads can stay active together.</p></div><Badge testId="pressure-state" tone={statusTone(pressurePhase)}>{activePressureIds.length > 1 ? `PRESSURE OBSERVED · ${activePressureIds.length} POOLS` : pressureLabel(pressurePhase)}</Badge></div>
            <div className="button-row weighted-actions dynamo-actions-row">
              <button className="secondary-button warning-button" type="button" data-testid="release-pressure" disabled={busy || trafficRunning || !pools.some((pool) => ["starting", "applied", "recovering", "recovery-pending", "failed"].includes(pressureRunFor(pool.id).phase))} onClick={() => void perform("/api/pressure/stop", "Stopping all run-owned pool pressure and waiting for each pool to recover.")}>Recover all pools</button>
              <button className="secondary-button" type="button" data-testid="probe-gateway" disabled={busy || trafficRunning || !localProbeReady} onClick={() => void perform("/api/probe", "Sending a new, uniquely identified request through the local Hub Gateway.")}>Send Hub route probe</button>
              <button className="secondary-button" type="button" data-testid="reset-baseline" disabled={busy || trafficRunning} onClick={() => void perform("/api/reset", "Resetting owned load and peer state, then checking a fresh baseline route.")}>Reset baseline</button>
              <a className="secondary-button peer-jump" href="#peerControls" data-testid="peer-controls-link">Optional peer test ↓</a>
            </div>
            <div className="traffic-sampler" data-testid="traffic-sampler">
              <div className="traffic-sampler-controls">
                <label>Requests
                  <input data-testid="traffic-count" type="number" min="1" max="24" value={sampleCount} disabled={busy || trafficRunning} onChange={(event) => setSampleCount(Math.min(24, Math.max(1, Number(event.target.value) || 1)))} />
                </label>
                <button className="primary-button" type="button" data-testid="generate-traffic" disabled={!trafficCanStart || sampleCount < 1 || sampleCount > 24} onClick={() => void perform("/api/traffic/start", activePressureIds.length ? `Waiting for the Site Gateway to observe ${activePressureIds.map(poolDisplayName).join(" and ")} at the demo pressure reference, then sending new requests.` : "Sending bounded real chat requests through the Site Gateway and counting emitted pool attribution.", "", { count: sampleCount, concurrency: 3, rate: 3 })}>Generate requests</button>
                <button className="secondary-button" type="button" data-testid="stop-traffic" disabled={busy || !trafficRunning} onClick={() => void perform("/api/traffic/stop", "Stopping run-owned Site Gateway requests and preserving completed results.")}>Stop</button>
                <Badge testId="traffic-state" tone={trafficRunning ? "live" : traffic.phase === "completed" ? "live" : "unknown"}>{trafficRunning ? "GENERATING" : String(traffic.phase || "UNAVAILABLE").toUpperCase()}</Badge>
              </div>
              <div className="traffic-sampler-status" data-testid="traffic-sampler-status" role="status">{trafficMessage}<small>Site Gateway GridSiteRoute · pool counts from response site/backend headers · cumulative counters from live praxis_http_requests_total.</small></div>
            </div>
            <div className="operation-stages" role="status" aria-live="polite">
              <strong>{busy ? "Action in progress" : pressureLabel(pressurePhase)}</strong>
              <span id="actionMessage">{busy ? actionMessage : error ? `ACTION FAILED · ${error}` : actionState()}</span>
              {error && <span className="error-text" role="alert">{error}</span>}
            </div>
            <details className="pressure-chart-disclosure">
              <summary>Show {pressureTargetName} active-request samples · actual /metrics</summary>
              <div className="pressure-chart-box">
                <div className="chart-heading"><span>Frontend active requests · {pressureTargetName}</span><small>{pressureCapacityReady ? `Grid comparison reference ${pressurePool.capacity}` : "Grid comparison reference unavailable"}</small></div>
                <svg className="pressure-chart" viewBox="0 0 720 100" preserveAspectRatio="none" role="img" aria-label="Live Frontend active request samples"><path className="chart-grid" d="M0 20H720 M0 50H720 M0 80H720" /><polyline className="active-line" points={chartPoints} /></svg>
                <div className="chart-legend"><span><i className="legend-dot active" />Observed active requests</span><span>{latestSample ? `${latestActive} active · ${formatTime(latestSample.sampledAt)}` : "No fresh sample"}</span></div>
              </div>
            </details>
          </article>
        </section>

        <section className="panel request-stream dynamo-request-stream">
          <div className="panel-heading compact"><div><span className="eyebrow">Real Gateway traffic</span><h2>Recent attributed requests</h2><p>Hub probes use unique Gateway counter deltas; Site Gateway samples use emitted site/backend response attribution.</p></div><Badge tone={state?.gatewayMetrics?.local?.status === "LIVE" && state?.gatewayMetrics?.crossSite?.status === "LIVE" ? "live" : "unknown"}>HUB {state?.gatewayMetrics?.local?.status || "UNAVAILABLE"} · SITE {state?.gatewayMetrics?.crossSite?.status || "UNAVAILABLE"}</Badge></div>
          <div className="request-table-wrap"><table className="request-table dynamo-request-table"><thead><tr><th>Request ID</th><th>HTTP</th><th>Route site</th><th>Route backend</th><th>Provider site</th><th>Response</th></tr></thead>
            <tbody>{sortedProbes.map((probe) => {
              const local = probe.kind === "local";
              const sampler = probe.kind === "sampler";
              const selected = probe.routingEvidence?.gatewayRequestDelta?.status === "LIVE" && probe.routingEvidence?.gatewayRequestDelta?.total === 1 ? probe.routingEvidence.gatewayRequestDelta.selectedBackend : null;
              const site = probe.attribution?.site || (local ? "Not emitted by this route" : "UNAVAILABLE");
              const backend = probe.attribution?.backend || (local && selected ? `${selected} · one Gateway request counter increment` : "UNAVAILABLE");
              const providerSite = probe.attribution?.providerSite || "Not emitted by this route";
              const responseText = probe.validResponse ? "Valid Mocker response" : "Invalid or unavailable response";
              return <tr key={probe.id || probe.requestId} data-testid="probe-result">
                <td title={probe.requestId || ""}>{short(probe.requestId, 27)}<span className="secondary-cell">{local ? "Hub Gateway" : sampler ? "Site Gateway sampler" : "Site Gateway probe"} · {formatTime(probe.completedAt)}</span></td>
                <td><span className={`http-status ${probe.validResponse ? "ok" : "error"}`}>{probe.status || "—"}</span></td>
                <td>{site}</td><td>{backend}</td><td>{providerSite}</td>
                <td className={probe.validResponse ? "response-valid" : "response-failed"}>{responseText}</td>
              </tr>;
            })}
              {!sortedProbes.length && <tr><td colSpan="6" className="empty-state">Send a fresh route probe or generate a request sample to populate this live ledger.</td></tr>}
            </tbody>
          </table></div>
        </section>

        <details id="peerControls" className="panel peer-details" data-testid="peer-controls">
          <summary><span><span className="eyebrow">Optional peer condition</span><strong>Signal endpoint interruption and restoration</strong></span><Badge id="peerState" tone={statusTone(signalCondition)}>{signalCondition}</Badge></summary>
          <div className="peer-body">
            <p>This presenter-only control changes the run-owned peer signal endpoint to a verified unserved port. The provider Gateway endpoint stays unchanged. This demonstrates local fallback and restoration; it is a <strong>signal endpoint interruption</strong>, not a network ACL or live SWIM partition.</p>
            <div className="peer-facts"><span>Remote signal endpoint <strong>{peer.signalsAddress || "UNAVAILABLE"}</strong></span><span>Provider Gateway <strong>{peer.gatewayAddress || "UNAVAILABLE"}</strong></span><span>Provider Gateway deployment <strong>{peer.providerGatewayReady === true ? `READY · ${peer.providerGatewayReplicas}` : peer.providerGatewayReady === false ? `NOT READY · ${peer.providerGatewayReplicas}` : "UNAVAILABLE"}</strong></span></div>
            <div className="button-row peer-actions">
              <button className="secondary-button warning-button" type="button" data-testid="interrupt-peer" disabled={busy || hasInterruption || signalCondition !== "LIVE" || pressurePhase === "applied"} onClick={() => void perform("/api/peer/interrupt", "Interrupting only the run-owned peer signal endpoint and waiting for Grid’s fallback state.", "Change only this run’s remote GridSite signalsEndpoint to a verified unserved port? The provider Gateway endpoint will be checked and preserved.")}>Interrupt signal endpoint…</button>
              <button className="secondary-button" type="button" data-testid="restore-peer" disabled={busy || !hasInterruption} onClick={() => void perform("/api/peer/restore", "Restoring the saved peer signals address and waiting for fresh remote data.")}>Restore peer signals</button>
              <button className="secondary-button" type="button" data-testid="probe-peer" disabled={busy || peer.status !== "LIVE" || !peerProbeReady} onClick={() => void perform("/api/peer/probe", "Sending a real request through the Site Gateway and reading emitted attribution.")}>{peerProbeLabel}</button>
            </div>
            <div className="operation-stages peer-message" id="peerMessage" role="status" aria-live="polite">
              {interruption.phase === "interrupted" ? fallbackReady
                ? `SIGNAL ENDPOINT INTERRUPTION observed · provider Gateway remains ${interruption.providerGatewayReachable ? "TCP reachable" : "not confirmed reachable"}. Hub scores are UNAVAILABLE after the ${candidateWindow}s route freshness window; the Site pool score is fresh. Probe to confirm local fallback.`
                : `SIGNAL ENDPOINT INTERRUPTION observed · provider Gateway remains ${interruption.providerGatewayReachable ? "TCP reachable" : "not confirmed reachable"}. Waiting for the ${candidateWindow ?? "unknown"}s Site Gateway freshness window and fresh local fallback state.`
                : interruption.phase === "restored" ? peerSnapshotFresh ? "Peer signal endpoint restored. Fresh Site Gateway signals are visible again; probe to confirm the restored route." : "Peer signal endpoint restored. Waiting for a fresh Site Gateway sample set before enabling a route probe."
                  : interruption.phase === "interrupting" ? "Interrupting only the run-owned peer signal endpoint. Waiting for Grid’s live peer condition to change."
                    : interruption.phase === "restoring" ? "Restoring the saved peer signal address. Waiting for fresh peer signals."
                      : `Peer signal condition ${String(signalCondition).toLowerCase()} · provider Gateway endpoint ${peer.providerGatewayReady ? "ready" : "not ready"}.`}
            </div>
            <div className="peer-route-panel">
              <div className="panel-heading compact"><div><span className="eyebrow">Site Gateway</span><h3>GridSiteRoute candidate snapshot</h3></div><Badge id="peerCandidateState" tone={peerCandidateStatus === "LIVE" ? "live" : "unknown"}>{peerCandidateStatus === "LIVE" ? "LIVE ROUTE METRICS" : peerCandidateStatus}</Badge></div>
              <div className="table-wrap"><table className="request-table peer-candidate-table"><thead><tr><th>Site / pool</th><th>Route score</th><th>Rank</th><th>Sample age</th></tr></thead>
                <tbody>{peerCandidates.map((candidate) => {
                  const fresh = freshCandidate(candidate);
                  const ageState = fresh ? "LIVE" : Number.isFinite(candidate.sampleAgeSeconds) && Number.isFinite(candidateWindow) && candidate.sampleAgeSeconds > candidateWindow ? "STALE" : "UNAVAILABLE";
                  const poolLabel = poolDisplayName(candidate.cluster);
                  return <tr key={`${candidate.site}-${candidate.cluster}`} data-testid={`peer-candidate-${candidate.cluster}`} className={fresh ? "" : ageState === "STALE" ? "candidate-stale" : "candidate-unavailable"}>
                    <td>{candidate.site} · {poolLabel}<span className="secondary-cell">Site Gateway RouteSnapshot · score {candidate.scoreStatus || "UNAVAILABLE"}</span></td>
                    <td className="score">{fresh ? candidate.score.toFixed(3) : "—"}</td>
                    <td>{peerSnapshotFresh && Number.isInteger(candidate.scoreOrder) ? <span className="rank-badge">{candidate.scoreOrder}</span> : "—"}</td>
                    <td>{fresh ? formatAge(candidate.sampleAgeSeconds) : ageState}</td>
                  </tr>;
                })}
                  {!peerCandidates.length && <tr><td colSpan="4" className="empty-state">{peerCandidateStatus} · waiting for live Site Gateway metrics</td></tr>}
                </tbody>
              </table></div>
              <p className="panel-note">These Gateway metrics describe a separate GridSiteRoute snapshot. They do not join the Hub’s local Dynamo pressure overlay.</p>
            </div>
          </div>
        </details>

        <details id="identityDetails" className="identity-details">
          <summary>Show exact source, image and cluster identity</summary>
          <pre id="identityBlock">{state ? JSON.stringify({
            runId: state.runId,
            gridCommit: state.identity?.gridCommit,
            gridSourceStateSha256: state.identity?.gridSourceStateSha256,
            gridTrackedDiffSha256: state.identity?.gridTrackedDiffSha256,
            gridImageLock: state.identity?.gridImageLock,
            dynamoImage: state.identity?.dynamoImage,
            dynamoKubernetesImage: state.identity?.dynamoKubernetesImage,
            dynamoImageId: state.identity?.dynamoImageId,
            kindNodeImage: state.identity?.kindNodeImage,
            gridImages: state.identity?.gridImages,
            architecture: state.identity?.architecture,
            clusters: Object.fromEntries(Object.entries(state.clusters || {}).map(([key, item]) => [key, { name: item.name, context: item.context }])),
          }, null, 2) : "Loading non-secret runtime identity…"}</pre>
        </details>
      </main>

      <footer className="dynamo-scope-footer">
        <span><b>REAL SIGNALS</b> Dynamo Frontend model readiness and active requests</span>
        <span><b>SYNTHETIC RESPONSE</b> Dynamo Mocker · no GPU or model-quality claim</span>
        <span><b>OUT OF SCOPE</b> weighted-share precision · live SWIM · llm-d/EPP queues</span>
        <span><b>DATA STATES</b> Live · Stale · Unavailable · Configured</span>
      </footer>
      <div className="caption-safe" aria-hidden="true" />
    </div>
  );
}

export default DynamoDashboard;
