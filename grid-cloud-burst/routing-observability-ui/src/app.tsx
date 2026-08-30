import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import CloudBurstPanel from "./CloudBurstPanel";
import {
  Activity,
  ArrowDown,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  ExternalLink,
  GitBranch,
  Moon,
  Network,
  Play,
  RefreshCw,
  Server,
  Sun,
  Terminal,
  X,
} from "lucide-react";
import {
  ReactFlow,
  Background,
  BaseEdge,
  Controls,
  getSmoothStepPath,
  Position,
  type Edge,
  type EdgeProps,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api } from "./lib/api";
import type { Capabilities, Provider, RequestItem, Status } from "./lib/types";
import {
  evidenceClass,
  providerText,
  statusText,
  time,
  title,
} from "./lib/formatting";

type Theme = "light" | "dark" | "system";
const scenarios = [
  { id: "baseline", label: "Baseline" },
  { id: "pressure", label: "Pressure" },
  { id: "recovery", label: "Recovery" },
  { id: "degraded", label: "Degraded" },
];

function useTheme() {
  const [theme, setTheme] = useState<Theme>(
    (localStorage.getItem("praxis-theme") as Theme) || "light",
  );
  useEffect(() => {
    const dark =
      theme === "dark" ||
      (theme === "system" &&
        matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("praxis-theme", theme);
  }, [theme]);
  return { theme, setTheme };
}

function Badge({
  children,
  tone = "unknown",
  id,
}: {
  children: React.ReactNode;
  tone?: string;
  id?: string;
}) {
  return (
    <span id={id} className={`badge badge-${tone}`}>
      {children}
    </span>
  );
}

function quotaProviderLabel(provider: Provider): string {
  const raw = provider.site || provider.cluster || provider.name || provider.id || "provider";
  const site = raw.toLowerCase()
    .replace(/^vllm-vcr[- ]?/, "")
    .replace(/^vcr[- ]?inference[- ]?/, "")
    .replace(/^vcr[- ]?/, "")
    .replace(/\s+provider$/, "")
    .replace(/-provider$/, "")
    .replace(/^provider-/, "");
  return `${site.replace(/\b\w/g, (letter) => letter.toUpperCase())} Provider`;
}

function quotaProviderName(raw: string): string {
  const site = raw.toLowerCase()
    .replace(/^vllm-vcr[- ]?/, "")
    .replace(/^vcr[- ]?inference[- ]?/, "")
    .replace(/^vcr[- ]?/, "")
    .replace(/\s+provider$/, "")
    .replace(/-provider$/, "")
    .replace(/^provider-/, "");
  return `${site.replace(/\b\w/g, (letter) => letter.toUpperCase())} Provider`;
}

function quotaBackendLabel(raw: string): string {
  const value = String(raw || "");
  const match = value.toLowerCase().match(/(?:vllm-vcr|vcr(?:-inference)?)[-_ ]?(east|central|west)/);
  return match ? `vLLM ${match[1]} backend` : value.replace(/vcr/gi, "vLLM").replaceAll("-", " ");
}

function displayHopLabel(label: string, tokenProfile = false): string {
  if (tokenProfile) {
    const match = label.toLowerCase().match(/^(?:vcr-)?(east|central|west)(?:-provider)?$/);
    if (match) return `vLLM ${match[1]} provider`;
  }
  return label === "vllm-vcr" ? "vLLM" : String(label).replaceAll("-", " ");
}

function TokenPath({ row }: { row: any }) {
  const hops = Array.isArray(row.route?.hops) ? row.route.hops : [];
  const labels = hops.length
    ? hops
    : [
        "client",
        row.consumer || row.consumer_gateway || "consumer gateway",
        row.admission === "unavailable"
          ? "quota unavailable"
          : "quota denied",
      ];
  return (
    <div
      className={`token-path ${row.admission === "admitted" ? "admitted" : "stopped"}`}
      aria-label={`Observed path: ${labels.join(" then ")}`}
    >
      {labels.map((label: string, index: number) => (
        <Fragment key={`${label}-${index}`}>
          {index > 0 && (
            <span className="token-path-edge" aria-hidden="true">
              →
            </span>
          )}
          <span
            className={`token-path-chip ${
              row.admission === "admitted" && index === labels.length - 2
                ? "provider"
                : ""
            }`}
          >
            {displayHopLabel(label, true)}
          </span>
        </Fragment>
      ))}
      {row.admission !== "admitted" && (
        <small className="token-no-hop">{row.http?.status || row.status || "429"} · no provider hop</small>
      )}
    </div>
  );
}

function TokenSettlement({ row }: { row: any }) {
  const quota = row.quota || {};
  const governance = quota.governance === "over_allocation" ? "soft · over allocation" : quota.governance === "within" ? "soft · within allocation" : null;
  const governanceLabel = governance ? <small className={`token-settlement ${quota.governance === "over_allocation" ? "overage" : ""}`}>{governance}</small> : null;
  if (quota.settlement === "refund") return <>{governanceLabel}<small className="token-settlement refund">Reserved {quota.reservation_estimate} · actual {quota.actual_tokens} · refunded {quota.refund_tokens}</small></>;
  if (quota.settlement === "overage") return <>{governanceLabel}<small className="token-settlement overage">Reserved {quota.reservation_estimate} · actual {quota.actual_tokens} · overage {quota.overage_tokens}</small></>;
  if (quota.settlement === "exact") return <>{governanceLabel}<small className="token-settlement">Reserved {quota.reservation_estimate} · actual {quota.actual_tokens}</small></>;
  return governanceLabel;
}

function SlidingWindowActivity({ status, rows }: { status: any; rows: any[] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const windowSeconds = Number(status?.policy?.window_seconds || 0);
  const windowMs = windowSeconds * 1000;
  const multiQuota = Boolean(status?.multi_quota);
  const activityRows = multiQuota ? rows.filter((row) => row.application) : rows;
  const admitted = activityRows
    .filter((row) => row.admission === "admitted" && row.started_at)
    .map((row) => {
      const at = Date.parse(row.started_at);
      const age = now - at;
      const actual = row.quota?.actual_tokens;
      return {
        row,
        at,
        age,
        expiresAt: at + windowMs,
        active: Number.isFinite(at) && age >= 0 && age < windowMs,
        knownTokens: Number.isFinite(Number(actual)) ? Number(actual) : null,
        requestedTokens: Number.isFinite(Number(row.requested_tokens ?? row.quota?.requested_tokens))
          ? Number(row.requested_tokens ?? row.quota?.requested_tokens)
          : null,
      };
    })
    .filter((entry) => Number.isFinite(entry.at));
  const active = admitted.filter((entry) => entry.active);
  const knownTokens = active.reduce((sum, entry) => sum + (entry.knownTokens ?? 0), 0);
  const knownCount = active.filter((entry) => entry.knownTokens !== null).length;
  const maxRequestedTokens = active.reduce((max, entry) => Math.max(max, entry.requestedTokens ?? 0), 0);
  const nextExpiry = active.toSorted((a, b) => a.expiresAt - b.expiresAt)[0];
  const latestRemaining = activityRows.find((row) => row.quota?.remaining !== null && row.quota?.remaining !== undefined)?.quota?.remaining;
  const formatRemaining = (ms: number) => {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
  };
  const appTimelines = multiQuota && Array.isArray(status.apps)
    ? status.apps.map((app: any) => ({
        app,
        entries: active.filter((entry) => entry.row.application === app.id),
      }))
    : [];

  return (
    <section className="quota-window-view" aria-label="Observed sliding-window activity">
      <div className="quota-window-heading">
        <div>
          <span className="eyebrow">Observed sliding-window activity</span>
          <strong>Live request charges and expiry countdown</strong>
        </div>
        <span className="muted-text">Live responses · countdown every second</span>
      </div>
      {!multiQuota && <div className="quota-window-stats">
        <div><span>Charges in window</span><strong>{active.length}</strong></div>
        <div><span>Observed total tokens</span><strong>{knownCount ? knownTokens : "—"}</strong><small>{knownCount ? `${knownCount} observed responses` : "Usage not exposed"}</small></div>
        <div><span>Latest reported remaining</span><strong>{latestRemaining ?? "—"}</strong><small>from response headers</small></div>
        <div><span>Max output tokens/request</span><strong>{status.policy?.max_tokens_per_request ?? "—"}</strong><small>random output range {status.policy?.request_token_range?.join("–") ?? "—"}</small></div>
        <div><span>Next expiry</span><strong>{nextExpiry ? formatRemaining(nextExpiry.expiresAt - now) : "—"}</strong><small>{nextExpiry ? "oldest observed charge" : "no active charge"}</small></div>
      </div>}
      {!multiQuota && <div className="quota-window-track" aria-label="Rolling window timeline">
        {active.slice(0, 24).map((entry) => {
          const progress = windowMs ? Math.min(100, Math.max(0, (entry.age / windowMs) * 100)) : 0;
          return (
            <div className="quota-window-charge active" key={entry.row.request_id} style={{ "--charge-color": entry.row.color || "var(--success)" } as React.CSSProperties} title={`${entry.row.request_id} · ${entry.knownTokens ?? "?"} observed total tokens · max ${entry.requestedTokens ?? "?"} output tokens requested · expires in ${formatRemaining(entry.expiresAt - now)}`}>
              <span style={{ left: `${progress}%` }} />
              <strong>{entry.knownTokens ?? entry.requestedTokens ?? "?"}</strong>
            </div>
          );
        })}
        {!active.length && <span className="muted-text">No active observed charges in the rolling window.</span>}
      </div>}
      {appTimelines.length > 0 && <div className="quota-app-timelines" aria-label="Per-application quota timelines">
        {appTimelines.map(({ app, entries }: any) => (
          <section className="quota-app-timeline" key={app.id} style={{ "--app-accent": app.color } as React.CSSProperties}>
            <div className="quota-app-timeline-heading">
              <strong>{app.name}</strong>
              <span>{entries.length} active charge{entries.length === 1 ? "" : "s"} · next expiry {entries.length ? formatRemaining(Math.max(0, entries.toSorted((a: any, b: any) => a.expiresAt - b.expiresAt)[0].expiresAt - now)) : "—"}</span>
            </div>
            <div className="quota-window-track">
              {entries.slice(0, 24).map((entry: any) => {
                const progress = windowMs ? Math.min(100, Math.max(0, (entry.age / windowMs) * 100)) : 0;
                return <div className="quota-window-charge active" key={entry.row.request_id} style={{ "--charge-color": app.color } as React.CSSProperties} title={`${entry.row.request_id} · ${entry.knownTokens ?? "?"} actual tokens · expires in ${formatRemaining(entry.expiresAt - now)}`}>
                  <span style={{ left: `${progress}%` }} />
                  <strong>{entry.knownTokens ?? "?"}</strong>
                </div>;
              })}
              {!entries.length && <span className="muted-text">No active {app.name} charges.</span>}
            </div>
          </section>
        ))}
      </div>}
      <p className="quota-window-note">Observed activity, not a direct Valkey ledger dump. Max output tokens is only the answer size. The quota counts the whole request: your prompt plus the answer. Charges can therefore be higher than the output cap. Charges remain visible until their timestamps leave the configured rolling window; there is no global clock reset.</p>
    </section>
  );
}

function TokenPolicyPanel({ policy }: { policy: any }) {
  return (
    <section className="panel quota-policy-view" aria-label="Active token quota policy">
      <div className="quota-policy-heading">
        <div>
          <span className="eyebrow">Active token quota policy</span>
          <strong>Policy is observable, not editable here</strong>
        </div>
        <span className="policy-algorithm">{policy.algorithm === "sliding_window" ? "Sliding window" : policy.algorithm}</span>
      </div>
      <div className="quota-policy-grid">
        <div><span>Principal</span><strong>{policy.principal}</strong></div>
        <div><span>Model</span><strong>{policy.model}</strong></div>
        <div><span>Window</span><strong>Rolling {policy.window_seconds} seconds</strong></div>
        <div><span>Capacity</span><strong>{policy.capacity_tokens} tokens</strong></div>
        <div><span>Accounting</span><strong>{policy.accounting === "total_tokens" ? "Total tokens only" : policy.accounting}</strong></div>
        <div><span>State backend</span><strong>{policy.backend}</strong></div>
      </div>
      <div className="quota-policy-unsupported">
        <span>Other policy algorithms</span>
        <span>Token bucket · {policy.unsupported_algorithms?.token_bucket || "Not implemented"}</span>
        <span>Fixed window · {policy.unsupported_algorithms?.fixed_window || "Not implemented"}</span>
        <span>Calendar window · {policy.unsupported_algorithms?.calendar_window || "Not implemented"}</span>
      </div>
    </section>
  );
}

function Topology({
  providers,
  requests,
  activeRequest,
  appColors,
  tokenProfile,
}: {
  providers: Provider[];
  requests: RequestItem[];
  activeRequest: RequestItem | null;
  appColors: string[];
  tokenProfile: boolean;
}) {
  const consumerKey = (request: RequestItem) =>
    String(
      request.consumer ||
        request.consumer_gateway ||
        request.route?.hops?.find((hop) => /consumer/i.test(hop)) ||
        "",
    ).toLowerCase();
  const providerFor = (request?: RequestItem | null): string | null =>
    request?.route?.provider_gateway || request?.provider || null;
  const currentProvider = providerFor(activeRequest);
  const routeText = (activeRequest?.route?.hops || []).join(" ").toLowerCase();
  const activeExternalRoute = /api\.openai\.com|openai route|bedrock route/.test(routeText);
  const providerMatchesGateway = (provider: Provider) => {
    if (!currentProvider) return false;
    const gateway = String(currentProvider).toLowerCase();
    return [provider.site, provider.cluster, provider.name, provider.id]
      .filter(Boolean)
      .some((value) => {
        const candidate = String(value).toLowerCase();
        const parts = candidate.split(/[-_. ]+/).filter(Boolean);
        return candidate === gateway || parts.includes(gateway) || candidate.includes(`-${gateway}`) || candidate.includes(` ${gateway}`) || gateway.includes(`-${candidate}`);
      });
  };
  const providerIsExternal = (provider: Provider) => Boolean(provider.external || provider.backend_kind === "api_provider" || provider.backend_kind === "cloud_managed" || /openai|bedrock|cloud/i.test(`${provider.cluster || ""} ${provider.site || ""} ${provider.name || ""}`));
  const providerIsActive = (provider: Provider) => providerMatchesGateway(provider) && providerIsExternal(provider) === activeExternalRoute;
  const activeProviderNames = new Set<string>();
  if (currentProvider) activeProviderNames.add(currentProvider);
  const currentConsumer = activeRequest ? consumerKey(activeRequest) : "";
  const consumerMatches = (value: string, key: string) => {
    const aliases = key === "a" ? ["a", "east"] : key === "b" ? ["b", "west"] : [key];
    return aliases.some((alias) => value === alias || value.includes(`${alias} consumer`) || value.endsWith(`consumer-gateway-${alias}`) || value.endsWith(`-${alias}`));
  };
  const PersonaEdge = (props: EdgeProps) => {
    const [path] = getSmoothStepPath(props);
    const colors = Array.isArray(props.data?.colors) && props.data.colors.length
      ? props.data.colors
      : ["var(--topology-edge)"];
    const gradientId = `persona-edge-${String(props.id).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    return <>
      {colors.length > 1 && <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
          {colors.map((color: string, index: number) => <stop key={`${gradientId}-${index}`} offset={`${(index / (colors.length - 1)) * 100}%`} stopColor={color} />)}
        </linearGradient>
      </defs>}
      <BaseEdge path={path} style={{ stroke: props.data?.selected ? "var(--primary)" : (colors.length > 1 ? `url(#${gradientId})` : colors[0]), strokeWidth: props.data?.selected ? 4 : 2.5, strokeDasharray: "5 5" }} />
    </>;
  };
  const consumerNodes = tokenProfile
    ? [
        { id: "consumer-a", label: "Consumer Gateway A", key: "a" },
        { id: "consumer-b", label: "Consumer Gateway B", key: "b" },
      ]
    : [{ id: "consumer", label: "Consumer gateway", key: "consumer" }];
  const nodes: Node[] = [
    {
      id: "client",
      position: { x: 20, y: 120 },
      data: {
        label: (
          <>
            <strong>Client</strong>
            <small>request origin</small>
          </>
        ),
      },
      className: "topology-node client",
      sourcePosition: Position.Right,
      },
    ...consumerNodes.map((consumer, index) => ({
      id: consumer.id,
      position: { x: 230, y: tokenProfile ? 70 + index * 130 : 120 },
      data: {
        label: (
          <>
            <strong>{consumer.label}</strong>
            <small>token_rate_limit → intelligent_route</small>
          </>
        ),
      },
      className: `topology-node consumer ${
        consumerMatches(currentConsumer, consumer.key)
          ? "current-consumer"
          : ""
      }`,
      style: consumerMatches(currentConsumer, consumer.key) && activeRequest?.color
        ? ({ "--app-accent": activeRequest.color } as React.CSSProperties)
        : undefined,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    })),
    ...providers.map((p, index) => ({
      id: `provider-${index}`,
      position: { x: 610, y: 40 + index * 105 },
      data: {
        label: (
          <>
            <strong>
              {tokenProfile
                ? quotaProviderLabel(p)
                : title(p.site || p.name || `Provider ${index + 1}`)}
            </strong>
            <small>InferenceProvider · {p.cluster || "provider gateway"}</small>
          </>
        ),
      },
      className: `topology-node provider ${
        providerIsActive(p) ||
        activeProviderNames.has(p.site || "") ||
        activeProviderNames.has(p.name || "") ||
        activeProviderNames.has(p.id || "")
          ? "active-provider"
          : ""
      }`,
      targetPosition: Position.Left,
    })),
  ];
  const edges: Edge[] = [
    ...consumerNodes.map((consumer) => ({
      id: `client-${consumer.id}`,
      type: "smoothstep",
      source: "client",
      target: consumer.id,
      className: consumerMatches(currentConsumer, consumer.key)
        ? "current-edge"
        : "muted-edge",
      animated: consumerMatches(currentConsumer, consumer.key),
      type: tokenProfile && appColors.length ? "persona" : "smoothstep",
      data: { colors: appColors, selected: consumerMatches(currentConsumer, consumer.key) },
    })),
    ...consumerNodes.flatMap((consumer) =>
      providers.map((provider, index) => {
        const providerId = provider.site || provider.name || provider.id;
        const current = consumerMatches(currentConsumer, consumer.key) && providerIsActive(provider);
        return {
          id: `${consumer.id}-provider-${index}`,
          type: "smoothstep",
          source: consumer.id,
          target: `provider-${index}`,
          className: current ? "current-edge" : "muted-edge",
          animated: Boolean(current),
          type: tokenProfile && appColors.length ? "persona" : "smoothstep",
          data: { colors: appColors, selected: current },
        };
      }),
    ),
  ];
  return (
    <div className="topology-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        edgeTypes={{ persona: PersonaEdge }}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        nodesDraggable={false}
        nodesConnectable={false}
        zoomOnScroll={false}
      >
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      <div className="topology-legend">
        <span>
          <i className="legend-dot active" />
          selected persona path
        </span>
        <span>
          <i className="legend-dot muted" />
          eligible routes · application paths
        </span>
      </div>
    </div>
  );
}

function ProviderCard({
  provider,
  tokenProfile = false,
}: {
  provider: Provider;
  tokenProfile?: boolean;
}) {
  const pressure =
    provider.pressure || (provider.status === "healthy" ? "normal" : "unknown");
  return (
    <article className="provider-card">
      <div className="provider-card-heading">
        <div className="provider-icon">
          <Server size={16} />
        </div>
        <div>
          <h3>{tokenProfile ? quotaProviderLabel(provider) : title(provider.site || provider.name)}</h3>
          <p>{tokenProfile ? quotaBackendLabel(provider.cluster || "Provider gateway") : provider.cluster || "Provider gateway"}</p>
        </div>
        <span className={`status-dot ${pressure}`} title={pressure} />
      </div>
      <div className="provider-metrics">
        <div>
          <span>{tokenProfile ? "Observed order" : "Rank"}</span>
          <strong>{provider.rank ?? "—"}</strong>
        </div>
        <div>
          <span>{tokenProfile ? "Selection" : "Score"}</span>
          <strong>
            {tokenProfile
              ? "roundRobin"
              : typeof provider.score === "number"
                ? provider.score.toFixed(3)
                : "—"}
          </strong>
        </div>
        <div>
          <span>{tokenProfile ? "Observed hits" : "Queue"}</span>
          <strong>
            {tokenProfile
              ? provider.queue_depth?.value ?? 0
              : provider.queue_depth?.value ?? "—"}
          </strong>
        </div>
      </div>
      <div className="provider-card-footer">
        <span className={`pressure pressure-${pressure}`}>
          {title(pressure)}
        </span>
        <span className="mono">
          {tokenProfile ? quotaProviderLabel(provider) : provider.id || provider.site || "provider"}
        </span>
      </div>
    </article>
  );
}

function RequestTable({
  requests,
  onSelect,
  selectedRequest,
}: {
  requests: RequestItem[];
  onSelect: (request: RequestItem) => void;
  selectedRequest: RequestItem | null;
}) {
  return (
    <div className="table-wrap">
      <table id="request-table" className="request-table">
        <thead>
          <tr>
            <th>Started</th>
            <th>Experience</th>
            <th>Status</th>
            <th>Provider / path</th>
            <th>Trace</th>
            <th />
          </tr>
        </thead>
        <tbody id="request-body">
          {requests.length ? (
            requests.map((request, index) => (
              <tr
                className={`request-row ${
                  selectedRequest &&
                  (selectedRequest.request_id || selectedRequest.id) ===
                    (request.request_id || request.id)
                    ? "selected"
                    : ""
                }`}
                key={String(request.request_id || request.id || index)}
                onClick={() => onSelect(request)}
                aria-label={`Replay evidence for ${request.request_id || request.id || index + 1}`}
              >
                <td className="mono">
                  {time(request.started_at || request.timestamp)}
                </td>
                <td>
                  <span
                    className={`experience-pill ${String(request.experience || "good").toLowerCase()}`}
                  >
                    {request.experience || "good"}
                  </span>
                </td>
                <td>
                  <span
                    className={`http-status ${Number(statusText(request)) < 400 ? "ok" : "error"}`}
                  >
                    {statusText(request)}
                  </span>
                </td>
                <td>
                  <strong>{title(providerText(request))}</strong>
                  <small className="table-subline">
                    {request.route?.hops?.join(" → ") || "observed route"}
                  </small>
                </td>
                <td>
                  {request.trace_id || request.trace?.trace_id ? (
                    <span className="trace-chip">
                      <CheckCircle2 size={13} /> traced
                    </span>
                  ) : (
                    <span className="muted-text">boundary</span>
                  )}
                </td>
                <td>
                  <button
                    className="icon-button request-open"
                    aria-label="Inspect request"
                    onClick={() => onSelect(request)}
                  >
                    <ChevronRight size={16} />
                  </button>
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={6} className="empty-state">
                No request evidence in the selected window.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function RequestDetail({
  request,
  onClose,
}: {
  request: RequestItem | null;
  onClose: () => void;
}) {
  if (!request)
    return (
      <section
        id="request-detail"
        className="panel request-detail-panel hidden"
      />
    );
  const hops = request.route?.hops || [
    "client",
    "consumer gateway",
    "intelligent_route",
    providerText(request),
  ];
  return (
    <section
      id="request-detail"
      className="panel request-detail-panel"
      aria-live="polite"
    >
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Request detail</span>
          <h2 id="request-detail-title">
            {request.request_id || request.id || "Observed request"}
          </h2>
        </div>
        <button className="secondary-button" onClick={onClose}>
          <X size={15} /> Close
        </button>
      </div>
      <div id="request-detail-content">
        <div className="detail-flow">
          {hops.map((hop, index) => (
            <div className="request-flow-node" key={`${hop}-${index}`}>
              <strong>{title(hop)}</strong>
              <small>{request.trace_id ? "traced" : "boundary"}</small>
            </div>
          ))}
        </div>
        <div className="detail-grid">
          <div>
            <span>HTTP status</span>
            <strong>{statusText(request)}</strong>
          </div>
          <div>
            <span>Provider</span>
            <strong>{title(providerText(request))}</strong>
          </div>
          <div>
            <span>Trace ID</span>
            <strong className="mono">
              {request.trace_id || request.trace?.trace_id || "not indexed"}
            </strong>
          </div>
          <div>
            <span>Why this experience score?</span>
            <strong>
              {request.experience || "Observed route and HTTP result"}
            </strong>
          </div>
        </div>
        {(request.trace_id || request.trace?.trace_id) && (
          <div className="trace-inspection-actions">
            <button className="secondary-button" onClick={() => window.open(request.jaeger_url || request.trace?.jaeger_url || `http://localhost:16686/trace/${request.trace_id || request.trace?.trace_id}`, "praxis-jaeger", "width=1280,height=900") }>
              <ExternalLink size={14} /> Open routing span in Jaeger
            </button>
          </div>
        )}
        <div className="callout">
          <CircleHelp size={16} />
          <span>
            Replay safe synthetic request: this detail reflects the evidence
            returned by the selected source.
          </span>
        </div>
      </div>
    </section>
  );
}

function TokenPanel() {
  const [status, setStatus] = useState<any>(null);
  const [rows, setRows] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [fixtureState, setFixtureState] = useState("recovered");
  const [charges, setCharges] = useState<Record<string, number>>({});
  const [tokenRequestPage, setTokenRequestPage] = useState(1);
  const refresh = useCallback(async () => {
    try {
      const value = await api.tokenStatus(fixtureState);
      if (!(value as any).enabled) {
        setStatus(null);
        setRows([]);
        return;
      }
      const data = (value as any).data || value;
      setStatus({
        ...(value as any),
        ...data,
        principal: data.multi_quota ? data.apps.map((app: any) => app.name).join(" · ") : `${data.principal || data.username || "alice"}/${data.model || "canonical-model"}`,
        fixture: (value as any).fixture_mode === "token-rate-limit",
      });
      setRows(data.requests || []);
    } catch {
      setStatus(null);
    }
  }, [fixtureState]);
  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh]);
  const live = status?.source === "live" || status?.mode === "live";
  const request = async (consumer: "a" | "b", app?: string) => {
    setBusy(true);
    try {
      const result = await api.tokenRequest(consumer, app, app ? charges[app] || 5 : undefined);
      await refresh();
      window.dispatchEvent(
        new CustomEvent("token-rate-limit-updated", {
          detail: (result as any).record || null,
        }),
      );
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    if (
      !rows.length ||
      !confirm(
        "Clear displayed results? Shared quota state and traces will not be changed.",
      )
    )
      return;
    await api.clearTokenResults();
    await refresh();
    window.dispatchEvent(new Event("token-rate-limit-updated"));
  };
  const renderedRows = rows.map((r) => ({
    ...r,
    consumer: r.consumer || r.consumer_gateway,
    provider: r.provider || r.route?.provider_gateway,
    status: r.status
      ? `HTTP ${r.status}`
      : r.http?.status
        ? `HTTP ${r.http.status}`
        : null,
  }));
  const tokenRequestPageCount = Math.max(1, Math.ceil(renderedRows.length / REQUESTS_PER_PAGE));
  const visibleTokenRows = useMemo(() => {
    const page = Math.min(tokenRequestPage, tokenRequestPageCount);
    const start = (page - 1) * REQUESTS_PER_PAGE;
    return renderedRows.slice(start, start + REQUESTS_PER_PAGE);
  }, [renderedRows, tokenRequestPage, tokenRequestPageCount]);
  useEffect(() => {
    setTokenRequestPage(1);
  }, [fixtureState]);
  useEffect(() => {
    setTokenRequestPage((page) => Math.min(page, tokenRequestPageCount));
  }, [tokenRequestPageCount]);
  const providerDistribution = renderedRows.reduce<Record<string, number>>(
    (counts, row) => {
      if (row.admission === "admitted" && row.provider) {
        counts[row.provider] = (counts[row.provider] || 0) + 1;
      }
      return counts;
    },
    {} as Record<string, number>,
  );
  const admittedCount = Object.values(providerDistribution).reduce(
    (total, count) => total + count,
    0,
  );
  const appProviderDistribution = (status?.multi_quota && Array.isArray(status.apps) ? status.apps : []).flatMap((app: any) => {
    const counts: Record<string, number> = {};
    renderedRows.filter((row) => row.application === app.id && row.admission === "admitted" && row.provider)
      .forEach((row) => { counts[row.provider] = (counts[row.provider] || 0) + 1; });
    return Object.entries(counts).map(([provider, count]) => ({ app, provider, count }));
  });
  return (
    <section
      id="token-rate-limit-panel"
      className={`panel token-panel ${status ? "" : "hidden"}`}
    >
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Opt-in quota demo</span>
          <h2>{status?.multi_quota ? "Multi-application token quotas" : "Shared token-rate limit"}</h2>
          <p className={status?.multi_quota ? "multi-quota-subtitle" : undefined}>
            {status?.multi_quota
              ? `Live ${status.apps.map((app: any) => app.name).join(", ")} requests through two consumer gateways with independent shared quotas. Denied traffic stops before provider routing.`
              : "Live requests through two consumer gateways sharing one model quota. Denied traffic stops before provider routing."}
          </p>
        </div>
        <Badge
          id="token-rate-limit-source"
          tone={live ? "live" : status?.fixture ? "simulation" : "unknown"}
        >
          {live ? "LIVE" : status?.fixture ? "SYNTHETIC FIXTURE" : "DISABLED"}
        </Badge>
      </div>
      {status && (
        <>
          <div
            id="token-rate-limit-controls"
            className="quota-controls fixture-controls"
          >
            {status.fixture &&
              ["recovered", "admitted", "exhausted", "concurrent-race"].map(
                (state) => (
                  <button
                    key={state}
                    className={`secondary-button token-state-btn ${fixtureState === state ? "active" : ""}`}
                    data-token-state={state}
                    onClick={() => setFixtureState(state)}
                  >
                    {title(state)}
                  </button>
                ),
              )}
          </div>
          <div
            id="token-rate-limit-live-controls"
            className={`quota-controls ${status.fixture ? "hidden" : ""}`}
          >
            {!status.multi_quota && <button
              id="token-request-a"
              className="primary-button"
              disabled={busy}
              onClick={() => request("a")}
            >
              Request through Consumer A
            </button>}
            {!status.multi_quota && <button
              id="token-request-b"
              className="primary-button"
              disabled={busy}
              onClick={() => request("b")}
            >
              Request through Consumer B
            </button>}
            <button
              id="token-clear-results"
              className="secondary-button"
              disabled={busy || !rows.length}
              onClick={clear}
            >
              Clear results
            </button>
          </div>
          {status?.cloud_burst && <CloudBurstPanel />}
          {status.multi_quota && Array.isArray(status.apps) && (
            <section className="multi-quota-apps" aria-label="Independent application quotas">
              <div className="multi-quota-heading"><div><span className="eyebrow">Application budgets</span><strong>{status.apps.length} independent sliding-window quotas · fixed reservation estimates</strong></div><span className="muted-text multi-quota-note">Color identifies the app path; identity and Valkey state remain authoritative.</span></div>
              <div className="multi-quota-app-grid">
                {status.apps.map((app: any) => {
                  const charge = charges[app.id] || 5;
                  return <article className="multi-quota-app-card" style={{ "--app-accent": app.color } as React.CSSProperties} key={app.id}>
                    <div className="multi-quota-app-title"><span className="multi-quota-swatch" /><strong>{app.name}</strong><span className="mono">{app.username}</span></div>
                    <div className="multi-quota-budget">{app.limit} tokens / rolling {app.window_seconds}s · reserves {app.estimate_tokens} tokens</div>
                    <div className="multi-quota-stats"><span>Used <b>{app.used ?? "—"}</b></span><span>Raw remaining tokens <b>{app.raw_remaining ?? "—"}</b></span><span>Admissible <b>{app.remaining ?? "—"}</b></span><span>Admitted <b>{app.admitted}</b></span><span>Blocked <b>{app.denied}</b></span></div>
                    <div className={`multi-quota-governance ${app.governance === "over_allocation" ? "overage" : app.governance === "approaching" ? "approaching" : ""}`}>
                      {app.governance === "over_allocation" ? "SERVED · over soft cap · no 429" : app.governance === "approaching" ? "Approaching soft cap" : "Within soft cap"}
                    </div>
                    <label className="multi-quota-slider">Output cap <input type="range" min="1" max="12" value={charge} onChange={(event) => setCharges((current) => ({ ...current, [app.id]: Number(event.target.value) }))} /><output>{charge} output tokens · fixed reservation {app.estimate_tokens || 5} tokens</output></label>
                    <div className="multi-quota-actions"><button className="primary-button" disabled={busy} onClick={() => request("a", app.id)}>{status.consumers?.[0] || "East Consumer Gateway"}</button><button className="primary-button" disabled={busy} onClick={() => request("b", app.id)}>{status.consumers?.[1] || "West Consumer Gateway"}</button></div>
                  </article>;
                })}
              </div>
            </section>
          )}
          <div id="token-rate-limit-summary" className={`quota-summary${status.multi_quota ? " quota-summary-multi" : ""}`}>
            <div>
              <span>Principal / model</span>
              {status.multi_quota ? <div className="quota-summary-app-list">{status.apps.map((app: any) => <strong key={app.id}><b>{app.name}</b><small>{app.model}</small></strong>)}</div> : <strong>{status.principal || status.username || "alice/canonical-model"}</strong>}
            </div>
            <div>
              <span>Limit</span>
              {status.multi_quota ? <div className="quota-summary-app-list">{status.apps.map((app: any) => <strong key={app.id}><b>{app.name}</b><small>{app.limit} tokens</small></strong>)}</div> : <strong>{`${status.quota?.configured_limit ?? status.quota?.limit ?? status.limit ?? "—"} tokens`}</strong>}
            </div>
            <div>
              <span>Remaining</span>
              {status.multi_quota ? <div className="quota-summary-app-list">{status.apps.map((app: any) => <strong key={app.id}><b>{app.name}</b><small>{app.raw_remaining ?? app.remaining ?? "—"} tokens</small></strong>)}</div> : <strong>{`${status.quota?.remaining ?? status.remaining ?? rows[0]?.quota?.remaining ?? "—"} tokens`}</strong>}
            </div>
            <div>
              <span>Backend</span>
              <strong>
                {status.quota?.backend || status.backend || "shared Valkey"}
              </strong>
            </div>
          </div>
          <div className="table-wrap">
            <table className="request-table token-request-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Application / consumer</th>
                  <th>Admission</th>
                  <th>Remaining</th>
                  <th>Observed path</th>
                  <th>HTTP</th>
                </tr>
              </thead>
              <tbody id="token-rate-limit-requests">
                {visibleTokenRows.length ? (
                  visibleTokenRows.map((r, i) => (
                    <tr key={i}>
                      <td>{(Math.min(tokenRequestPage, tokenRequestPageCount) - 1) * REQUESTS_PER_PAGE + i + 1}</td>
                      <td className="token-request-identity"><strong>{r.application || r.principal || "—"}</strong><small>{title(r.consumer)}</small></td>
                      <td>{r.admission || "—"}</td>
                      <td>{r.quota?.remaining ?? r.remaining ?? "—"}</td>
                      <td><TokenPath row={r} /><TokenSettlement row={r} /></td>
                      <td>{r.status || "—"}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="empty-state">
                      No live quota requests observed yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <RequestPagination
            page={Math.min(tokenRequestPage, tokenRequestPageCount)}
            pageCount={tokenRequestPageCount}
            onPageChange={(page) => setTokenRequestPage(Math.max(1, Math.min(page, tokenRequestPageCount)))}
          />
          <SlidingWindowActivity status={status} rows={rows} />
          <div className="quota-distribution" aria-label="Observed provider distribution">
            <div className="quota-distribution-heading">
              <span className="eyebrow">Observed provider distribution</span>
              <span className="muted-text">Admitted requests only</span>
            </div>
            <div className="quota-distribution-grid">
              {status.multi_quota ? (
                appProviderDistribution.length ? appProviderDistribution.map(({ app, provider, count }) => (
                  <div className="quota-distribution-card" style={{ "--app-accent": app.color } as React.CSSProperties} key={`${app.id}-${provider}`}>
                    <strong>{app.name} · {quotaProviderName(provider)}</strong>
                    <span>{count} request{count === 1 ? "" : "s"}</span>
                    <small>{app.limit}-token {app.name} quota</small>
                  </div>
                )) : <span className="muted-text">No admitted provider attribution yet.</span>
              ) : Object.keys(providerDistribution).length ? (
                Object.entries(providerDistribution).map(([provider, count]) => (
                  <div className="quota-distribution-card" key={provider}>
                    <strong>{quotaProviderName(provider)}</strong>
                    <span>{count} request{count === 1 ? "" : "s"}</span>
                    <small>
                      {admittedCount
                        ? `${((count / admittedCount) * 100).toFixed(1)}% of admitted`
                        : "—"}
                    </small>
                  </div>
                ))
              ) : (
                <span className="muted-text">No admitted provider attribution yet.</span>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

const REQUESTS_PER_PAGE = 20;

function RequestPagination({
  page,
  pageCount,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
}) {
  if (pageCount <= 1) return null;

  return (
    <nav className="request-pagination" aria-label="Request history pages">
      <button
        type="button"
        className="secondary-button"
        onClick={() => onPageChange(page - 1)}
        disabled={page === 1}
        aria-label="Previous request history page"
      >
        Previous
      </button>
      <div className="request-page-numbers">
        {Array.from({ length: pageCount }, (_, index) => index + 1).map((pageNumber) => (
          <button
            type="button"
            key={pageNumber}
            className={`request-page-number ${pageNumber === page ? "active" : ""}`}
            onClick={() => onPageChange(pageNumber)}
            aria-current={pageNumber === page ? "page" : undefined}
            aria-label={`Request history page ${pageNumber}`}
          >
            {pageNumber}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="secondary-button"
        onClick={() => onPageChange(page + 1)}
        disabled={page === pageCount}
        aria-label="Next request history page"
      >
        Next
      </button>
    </nav>
  );
}

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const [status, setStatus] = useState<Status>({});
  const [capabilities, setCapabilities] = useState<Capabilities>({});
  const [providers, setProviders] = useState<Provider[]>([]);
  const [requests, setRequests] = useState<RequestItem[]>([]);
  const [selected, setSelected] = useState<RequestItem | null>(null);
  const [selectedByApp, setSelectedByApp] = useState<Record<string, RequestItem | null>>({});
  const [source, setSource] = useState("glb");
  const [scenario, setScenario] = useState("baseline");
  const [notice, setNotice] = useState("Detecting environment…");
  const [generating, setGenerating] = useState(false);
  const [count, setCount] = useState(10);
  const [generatedResults, setGeneratedResults] = useState<RequestItem[]>([]);
  const [replayWindow, setReplayWindow] = useState(100);
  const [requestWindowMinutes, setRequestWindowMinutes] = useState(15);
  const [providerFilter, setProviderFilter] = useState("all");
  const [requestPage, setRequestPage] = useState(1);
  const [tokenData, setTokenData] = useState<any>(null);
  const tokenRateLimitProfile = capabilities.environment?.profile === "token_rate_limit";
  const activeRequest = selected || requests[0] || null;
  const explorerRequests = useMemo(() => {
    const cutoff = Date.now() - requestWindowMinutes * 60 * 1000;
    const inWindow = requests.filter((request) => {
      const started = Date.parse(request.started_at || request.timestamp || "");
      const provider = providerText(request) || request.route?.provider_gateway || "";
      return Number.isFinite(started) && started >= cutoff
        && (providerFilter === "all" || provider === providerFilter);
    });
    const count = Math.max(1, Math.ceil(inWindow.length * (replayWindow / 100)));
    return inWindow.slice(0, count);
  }, [providerFilter, replayWindow, requestWindowMinutes, requests]);
  const requestPageCount = Math.max(1, Math.ceil(explorerRequests.length / REQUESTS_PER_PAGE));
  const visibleExplorerRequests = useMemo(() => {
    const page = Math.min(requestPage, requestPageCount);
    const start = (page - 1) * REQUESTS_PER_PAGE;
    return explorerRequests.slice(start, start + REQUESTS_PER_PAGE);
  }, [explorerRequests, requestPage, requestPageCount]);
  useEffect(() => {
    setRequestPage(1);
  }, [providerFilter, replayWindow, requestWindowMinutes]);
  useEffect(() => {
    setRequestPage((page) => Math.min(page, requestPageCount));
  }, [requestPageCount]);
  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([
      api.status(),
      api.capabilities(),
      api.providers(),
      api.requests(100),
      api.source(),
      api.traces(),
      api.tokenStatus(),
      api.cloudBurst(),
    ]);
    const [s, c, p, r, src, traces, token, cloudBurst] = results;
    if (s.status === "fulfilled") setStatus(s.value);
    if (c.status === "fulfilled") setCapabilities(c.value);
    if (token.status === "fulfilled") {
      const data = (token.value as any).data || null;
      setTokenData(data);
      if (data?.source === "live" && Array.isArray(data.requests)) {
        setRequests(data.requests);
        if (data.multi_quota && Array.isArray(data.apps)) {
          setSelectedByApp((current) => {
            const next = { ...current };
            for (const app of data.apps) {
              const appRequests = data.requests.filter(
                (item: RequestItem) => item.application === app.id,
              );
              const currentRequest = current[app.id];
              const currentStillPresent = currentRequest && appRequests.some(
                (item: RequestItem) =>
                  (item.request_id || item.id) ===
                  (currentRequest.request_id || currentRequest.id),
              );
              next[app.id] = currentStillPresent ? currentRequest : appRequests[0] || null;
            }
            return next;
          });
        }
        setSelected((current) => {
          const stillPresent = current && data.requests.some(
            (item: RequestItem) =>
              (item.request_id || item.id) === (current.request_id || current.id),
          );
          return stillPresent ? current : data.requests[0] || null;
        });
      }
    }
    if (p.status === "fulfilled") {
      const liveProviders = p.value.providers || [];
      const tokenProviders = token.status === "fulfilled"
        ? Object.entries((token.value as any).data?.provider_distribution || {}).map(([site, hits], index) => ({
            id: site,
            name: site,
            site,
            cluster: `${site} provider gateway`,
            healthy: true,
            admission_state: "new_and_existing",
            rank: index,
            pressure: "normal",
            queue_depth: { value: Number(hits) },
          }))
        : [];
      const cloudCandidates = cloudBurst.status === "fulfilled" && Array.isArray((cloudBurst.value as any).groups)
        ? (cloudBurst.value as any).groups.map((candidate: any, index: number) => ({
            id: candidate.stable_id || candidate.cluster || candidate.site || `provider-${index}`,
            name: candidate.name || candidate.site || candidate.cluster,
            site: candidate.site || null,
            cluster: candidate.cluster || null,
            external: Boolean(candidate.external),
            backend_kind: candidate.backend_kind || null,
            selection_group: candidate.group ?? candidate.selection_group ?? 0,
            selection_tier: candidate.tier || candidate.selection_tier || null,
            admission_state: candidate.admission || candidate.admission_state || null,
            healthy: candidate.admission !== "none",
            rank: candidate.rank ?? index,
            pressure: candidate.admission === "existing_only" ? "high" : "normal",
            queue_depth: candidate.queue_depth == null ? null : { value: Number(candidate.queue_depth) },
          }))
        : [];
      setProviders(cloudCandidates.length ? cloudCandidates : (liveProviders.length ? liveProviders : tokenProviders));
    }
    if (r.status === "fulfilled") {
      const items = r.value.requests || r.value.items || [];
      if (token.status === "fulfilled" && (token.value as any).data?.source === "live") {
        // The quota adapter is the authoritative request source for this profile.
      } else if (items.length || traces.status !== "fulfilled") setRequests(items);
      else if (traces.value.traces?.length) setRequests(traces.value.traces);
      else if (
        s.status === "fulfilled" &&
        s.value.source_label === "MOCK DATA"
      ) {
        setRequests([
          {
            request_id: "demo-request-001",
            started_at: new Date().toISOString(),
            status: 200,
            provider: "provider-a",
            route: {
              provider_gateway: "provider-a",
              hops: [
                "client",
                "consumer gateway",
                "intelligent_route",
                "provider-a",
              ],
            },
            trace_id: "demo-trace-001",
            experience: "excellent",
          },
        ]);
      } else setRequests([]);
    }
    if (src.status === "fulfilled")
      setSource(src.value.source || src.value.data_source || "glb");
    setNotice(
      results.some((x) => x.status === "rejected")
        ? "Some live sources are unavailable"
        : "Live API connected",
    );
  }, []);
  const selectRequest = useCallback((request: RequestItem | null) => {
    setSelected(request);
    if (request?.application) {
      setSelectedByApp((current) => ({ ...current, [request.application as string]: request }));
    }
  }, []);
  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 3000);
    const onTokenUpdate = (event: Event) => {
      const record = (event as CustomEvent<RequestItem>).detail;
      if (record) {
        void refresh().finally(() => selectRequest(record));
      } else {
        void refresh();
      }
    };
    window.addEventListener("token-rate-limit-updated", onTokenUpdate);
    return () => {
      clearInterval(id);
      window.removeEventListener("token-rate-limit-updated", onTokenUpdate);
    };
  }, [refresh]);
  const changeSource = async (next: string) => {
    setSource(next);
    try {
      await api.setSource(next);
      await refresh();
    } catch {
      setNotice("Source change failed");
    }
  };
  const changeScenario = async (next: string) => {
    setScenario(next);
    try {
      await api.scenario(next);
      await refresh();
    } catch {
      setNotice("Scenario change failed");
    }
  };
  const generate = async () => {
    setGenerating(true);
    setNotice("Starting request generation");
    try {
      await api.generate({
        count,
        rate: 1,
        concurrency: 1,
        max_tokens: 5,
        pool: "pool-a",
        prompt: "dashboard observability request",
      });
      setNotice("Request generation complete");
      await refresh();
      if (evidence === "simulation") {
        setGeneratedResults(
          Array.from({ length: count }, (_, index) => ({
            request_id: `demo-generated-${index + 1}`,
            started_at: new Date().toISOString(),
            status: 200,
            provider: ["provider-a", "provider-b", "provider-c"][index % 3],
            route: {
              provider_gateway: ["provider-a", "provider-b", "provider-c"][
                index % 3
              ],
              hops: [
                "client",
                "consumer gateway",
                "intelligent_route",
                ["provider-a", "provider-b", "provider-c"][index % 3],
              ],
            },
            trace_id: `demo-generated-trace-${index + 1}`,
            experience: "excellent",
          })),
        );
      }
    } catch {
      setNotice("Request generation failed");
    } finally {
      setGenerating(false);
    }
  };
  const evidence = evidenceClass(
    status.evidence || status.source_label || status.mode,
  );
  const sourceLabel =
    tokenRateLimitProfile
      ? "TOKEN QUOTA"
      : source === "vcr" ? "llm-d/EPP" : source === "combined" ? "COMBINED" : "GLB";
  if (location.pathname === "/login") {
    return (
      <main className="login-page">
        <section className="login-card">
          <div className="brand-mark">P</div>
          <span className="eyebrow">Praxis Tracing</span>
          <h1>Sign in to the observability console</h1>
          <p>
            OAuth can be connected at this route by the deployment that owns
            authentication. This UI does not store credentials or implement an
            identity provider.
          </p>
          <button className="primary-button" onClick={() => navigate("/")}>
            Continue to console
          </button>
          <span className="muted-text">
            Authentication is supplied by the hosting boundary.
          </span>
        </section>
      </main>
    );
  }
  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">P</div>
          <div>
            <h1>Grid Routing Observability</h1>
            <p>Live infrastructure routing console</p>
          </div>
        </div>
        <div className="header-actions">
          <Badge id="source-badge" tone="source">
            {sourceLabel}
          </Badge>
          <Badge id="evidence-badge" tone={evidence}>
            {evidence === "live"
              ? "LIVE EVIDENCE"
              : evidence === "simulation"
                ? "SIMULATION ENABLED"
                : "UNAVAILABLE"}
          </Badge>
          <label className="theme-select">
            <span className="sr-only">Theme</span>
            <select
              value={theme}
              onChange={(e) => setTheme(e.target.value as Theme)}
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
              <option value="system">System</option>
            </select>
            {theme === "dark" ? <Moon size={15} /> : <Sun size={15} />}
          </label>
        </div>
      </header>
      <main className="main-shell">
        <section className="command-bar">
          <div>
            <span className="eyebrow">Routing control plane</span>
            <h2>Request intelligence</h2>
            <p>
              Inspect observed paths, provider eligibility, and the accepted
              routing context.
            </p>
          </div>
          <div className="source-switcher">
            <button
              id="btn-src-quota"
              className={tokenRateLimitProfile || tokenData?.source === "live" ? "active" : ""}
              onClick={() => document.getElementById("token-rate-limit-panel")?.scrollIntoView({ behavior: "smooth", block: "start" })}
            >
              Token quota
            </button>
            {!tokenRateLimitProfile && (
              <>
                <button
                  id="btn-src-glb"
                  className={source === "glb" ? "active" : ""}
                  onClick={() => changeSource("glb")}
                >
                  GLB
                </button>
                <button
                  id="btn-src-vcr"
                  className={source === "vcr" ? "active" : ""}
                  onClick={() => changeSource("vcr")}
                >
                  llm-d/EPP
                </button>
                <button
                  id="btn-src-combined"
                  className={source === "combined" ? "active" : ""}
                  onClick={() => changeSource("combined")}
                >
                  Combined
                </button>
              </>
            )}
          </div>
        </section>
        <section className="status-strip">
          <div className="status-item">
            <Activity size={16} />
            <span>Environment</span>
            <strong>{notice}</strong>
          </div>
          <div className="status-item">
            <GitBranch size={16} />
            <span>Capabilities</span>
            <strong>{capabilities.version || "v2 request explorer"}</strong>
          </div>
          <div className="status-item">
            <Clock3 size={16} />
            <span>Refresh</span>
            <strong>3 seconds</strong>
          </div>
        </section>
        {tokenRateLimitProfile && <>
          <TokenPanel />
          {tokenData?.multi_quota ? tokenData.apps.map((app: any) => {
            const appRequests = requests.filter((request: any) => request.application === app.id);
            const appActiveRequest = selectedByApp[app.id] ?? appRequests[0] ?? null;
            return <section className="panel topology-panel persona-topology-panel" key={app.id}>
              <div className="panel-heading">
                <div>
                  <span className="eyebrow" style={{ color: app.color }}>Live {app.name} topology</span>
                  <h2>Control-plane context and {app.name} request path</h2>
                  <p>Only {app.name} traffic is shown here. Eligible providers remain visible; the selected route uses {app.name} color.</p>
                  <p className="active-route-summary">
                    {appActiveRequest
                      ? `Active request ${appActiveRequest.request_id || appActiveRequest.id || "—"}: ${appActiveRequest.consumer_gateway || appActiveRequest.consumer || "consumer"} → ${appActiveRequest.route?.provider_gateway || appActiveRequest.provider || "no provider"}`
                      : `No live ${app.name} request observed yet.`}
                  </p>
                </div>
                <Badge tone="info">{providers.length || 0} eligible providers</Badge>
              </div>
              <Topology
                providers={providers}
                requests={appRequests}
                activeRequest={appActiveRequest}
                appColors={app.color ? [app.color] : []}
                tokenProfile={tokenRateLimitProfile}
              />
            </section>;
          }) : <section className="panel topology-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">Live topology</span>
                <h2>Control-plane context and request path</h2>
                <p>Active provider routes are red; eligible alternatives remain visible in gray.</p>
                <p className="active-route-summary">{activeRequest ? `Active request ${activeRequest.request_id || activeRequest.id || "—"}: ${activeRequest.consumer_gateway || activeRequest.consumer || "consumer"} → ${activeRequest.route?.provider_gateway || activeRequest.provider || "no provider"}` : "Select a request row to show its active path."}</p>
              </div>
              <Badge tone="info">{providers.length || 0} observed providers</Badge>
            </div>
            <Topology providers={providers} requests={requests} activeRequest={activeRequest} appColors={[]} tokenProfile={tokenRateLimitProfile} />
          </section>}
        </>}
        <section className="section-grid">
          <section id="request-explorer" className="panel explorer">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">Unified request explorer</span>
                <h2 id="request-explorer-title">Replayable request evidence</h2>
                <p>
                  Select an observed request to inspect its evidence, route, and
                  replay eligibility.
                </p>
              </div>
              <Badge tone={evidence}>
                {explorerRequests.length} requests in window
              </Badge>
            </div>
            <div className="toolbar">
              <label>
                Window
                <select value={requestWindowMinutes} onChange={(event) => setRequestWindowMinutes(Number(event.target.value))}>
                  <option value={15}>Last 15 minutes</option>
                  <option value={60}>Last hour</option>
                </select>
              </label>
              <label>
                Provider
                <select value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)}>
                  <option value="all">All providers</option>
                  {providers.map((p) => (
                    <option key={p.id || p.site} value={p.id || p.site || p.name}>
                      {tokenRateLimitProfile
                        ? quotaProviderName(p.site || p.name || p.id || "provider")
                        : title(p.site || p.name)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="history-control">
                Replay window · {requestWindowMinutes === 15 ? "Last 15 minutes" : "Last hour"}
                <input
                  id="history-scrubber"
                  type="range"
                  min="10"
                  max="100"
                  value={replayWindow}
                  onChange={(e) => setReplayWindow(Number(e.target.value))}
                />
                <span id="history-scrubber-label">
                  {replayWindow === 100
                    ? `All requests · ${requestWindowMinutes === 15 ? "15 minutes" : "1 hour"}`
                    : `Newest ${replayWindow}% · about ${Math.max(1, Math.round((requestWindowMinutes * replayWindow) / 100))} minutes of ${requestWindowMinutes === 15 ? "15 minutes" : "1 hour"}`}
                </span>
              </label>
              <button className="secondary-button" onClick={refresh}>
                <RefreshCw size={14} /> Refresh
              </button>
              <span className="live-indicator">
                <i /> Live stream connected
              </span>
            </div>
            <div id="request-summary-strip" className="summary-strip">
              <strong>{explorerRequests.length}</strong>
              <span>requests in window</span>
              <span className="summary-separator" />
              <strong>
                {explorerRequests.filter((r) => Number(statusText(r)) < 400).length}
              </strong>
              <span>successful</span>
              <span className="summary-separator" />
              <strong>
                {new Set(explorerRequests.map(providerText).filter(Boolean)).size}
              </strong>
              <span>providers</span>
            </div>
            <RequestTable
              requests={visibleExplorerRequests}
              onSelect={selectRequest}
              selectedRequest={activeRequest}
            />
            <RequestPagination
              page={Math.min(requestPage, requestPageCount)}
              pageCount={requestPageCount}
              onPageChange={(page) => setRequestPage(Math.max(1, Math.min(page, requestPageCount)))}
            />
          </section>
          <aside className="side-column">
            <section className="panel evidence-panel">
              <div className="panel-heading compact">
                <div>
                  <span className="eyebrow">
                    {tokenRateLimitProfile ? "Observed routing state" : "Accepted routing state"}
                  </span>
                  <h2>{tokenRateLimitProfile ? "Provider routes" : "Provider candidates"}</h2>
                </div>
                <Network size={18} />
              </div>
              <div className="provider-list">
                {providers.length ? (
                  providers.map((provider, index) => (
                        <ProviderCard
                        key={provider.id || provider.site || index}
                        provider={provider}
                        tokenProfile={tokenRateLimitProfile}
                      />
                    ))
                ) : (
                  <div className="empty-state">
                    Provider telemetry unavailable.
                  </div>
                )}
              </div>
            </section>
            {!tokenRateLimitProfile && <section className="panel overlay-panel">
              <div className="panel-heading compact">
                <div>
                  <span className="eyebrow">Grid → Praxis</span>
                  <h2>Serving snapshot</h2>
                </div>
                <CheckCircle2 size={18} className="success-icon" />
              </div>
              <div className="revision-row">
                <span>Overlay revision</span>
                <strong className="mono">
                  {String(
                    (status as any).overlay_revision ||
                      (status as any).overlay?.revision ||
                      tokenData?.requests?.find((r: any) => r.route?.overlay_revision)?.route?.overlay_revision ||
                      tokenRateLimitProfile ? "not exposed by gateway" : "not available",
                  )}
                </strong>
              </div>
              <div className="revision-row">
                <span>Praxis serving revision</span>
                <strong className="mono">
                  {String(
                    (status as any).serving_revision ||
                      tokenData?.requests?.find((r: any) => r.route?.overlay_revision)?.route?.overlay_revision ||
                      tokenRateLimitProfile ? "not exposed by gateway" : "not available",
                  )}
                </strong>
              </div>
              <p className="panel-note">
                {tokenRateLimitProfile
                  ? "Provider names and hit counts come from live response attribution. The current gateway does not emit its overlay revision header."
                  : "Provider selection runs from the accepted local snapshot. Grid is not called on the request path."}
              </p>
            </section>}
          </aside>
        </section>
        {!tokenRateLimitProfile && <section id="scenario-bar" className="panel scenario-panel">
          <div>
            <span className="eyebrow">Simulation controls</span>
            <h2>Scenario evidence</h2>
          </div>
          <div className="scenario-buttons">
            {scenarios.map((item) => (
              <button
                key={item.id}
                className={`scenario-btn ${scenario === item.id ? "active" : ""}`}
                data-scenario={item.id}
                onClick={() => changeScenario(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </section>}
        {!tokenRateLimitProfile && <section id="request-generator" className="panel generator-panel">
          <div className="panel-heading request-generator-header">
            <div>
              <span className="eyebrow">Controlled traffic</span>
              <h2>Generate Requests</h2>
              <p>
                {evidence === "unavailable"
                  ? "The gateway is not reachable; live generation is unavailable."
                  : "Send requests through the selected source and watch observed attribution update."}
              </p>
              <span className="data-quality-chip" id="capability-summary">
                {evidence === "unavailable" ? "GENERATION UNAVAILABLE" : notice}
              </span>
            </div>
            <span id="generator-status" className="generator-status">
              {generating ? "Starting" : "Ready"}
            </span>
          </div>
          <div className="generator-controls">
            <label>
              Requests
              <input
                id="generator-count"
                type="number"
                min="1"
                max="100"
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
              />
            </label>
            <label>
              Rate/sec
              <input id="generator-rate" type="number" defaultValue="1" />
            </label>
            <label>
              Traffic origin
              <select id="generator-pool">
                <option value="pool-a">Pool A gateway</option>
                <option value="pool-b">Pool B gateway</option>
              </select>
            </label>
            <label>
              Concurrent
              <input
                id="generator-concurrency"
                type="number"
                defaultValue="1"
              />
            </label>
            <label>
              Tokens/request
              <input id="generator-max-tokens" type="number" defaultValue="5" />
            </label>
            <label className="prompt-field">
              Prompt
              <input
                id="generator-prompt"
                defaultValue="dashboard observability request"
              />
            </label>
            <button
              id="generator-start"
              className="primary-button"
              disabled={generating}
              onClick={generate}
            >
              <Play size={14} /> Generate requests
            </button>
            <button
              id="generator-cancel"
              className="secondary-button"
              disabled={!generating}
              onClick={() => api.cancel()}
            >
              Stop
            </button>
            <button
              id="generator-clear"
              className="secondary-button"
              type="button"
              onClick={() => setGeneratedResults([])}
            >
              Clear results
            </button>
          </div>
          <div id="generator-progress" className="generator-progress">
            {generating
              ? "Starting request generation…"
              : "No requests generated yet."}
          </div>
          <div id="generator-results" className="generator-results">
            {generatedResults.length ? (
              <>
                <strong>Generated request results</strong> ·{" "}
                {evidence === "simulation" ? "SIMULATED" : "LIVE"}
                {generatedResults.map((request) => (
                  <div className="generated-result" key={request.request_id}>
                    <span className="generated-result-main">
                      {request.request_id} → {title(providerText(request))}
                    </span>
                    <span>{statusText(request)}</span>
                  </div>
                ))}
              </>
            ) : requests.length ? (
              `${requests.length} observed request results`
            ) : (
              "Each generated request will appear here with its result and observed route."
            )}
          </div>
        </section>}
        {!tokenRateLimitProfile && <TokenPanel />}
        <RequestDetail request={selected} onClose={() => setSelected(null)} />
        <section className="panel path-note">
          <div className="path-note-icon">
            <Terminal size={17} />
          </div>
          <div>
            <h2>Evidence first</h2>
            <p>
              Trace one request. Live, simulation, and unavailable states remain
              explicit. A missing telemetry source is never replaced with a
              convincing value.
            </p>
          </div>
          <button className="secondary-button">
            <Copy size={14} /> Copy status
          </button>
        </section>
        {tokenRateLimitProfile && tokenData?.policy && !tokenData?.multi_quota && (
          <TokenPolicyPanel policy={tokenData.policy} />
        )}
      </main>
      <footer className="app-footer">
        <span>Praxis Tracing · Grid routing console</span>
        <span>Live refresh every 3s</span>
        <a href={(status as any).jaeger_url || "http://localhost:16686"} target="_blank" rel="noreferrer">
          <ExternalLink size={12} /> Open Jaeger
        </a>
      </footer>
    </div>
  );
}
