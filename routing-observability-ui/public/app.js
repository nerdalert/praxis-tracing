(function () {
  'use strict';

  const REFRESH_INTERVAL = 3000;
  let currentMode = 'auto';
  let effectiveMode = 'unknown';
  let refreshTimer = null;
  let currentDataSource = 'glb';
  let previousPoolSnapshot = new Map();
  let requestItems = [];
  let requestCursor = null;
  let requestCapabilities = null;
  let requestEventSource = null;
  let replayTimer = null;
  let pendingRequestEvents = 0;
  let eventRefreshTimer = null;
  let lastGeneratorError = null;
  let currentGeneratorJob = null;
  let hiddenGeneratorJobId = null;
  let tokenRateLimitEnabled = false;
  let tokenRateLimitLive = false;
  let tokenRateLimitState = 'recovered';

  // -----------------------------------------------------------------------
  // API
  // -----------------------------------------------------------------------

  async function apiFetch(path, opts) {
    const res = await fetch(`/api${path}`, opts);
    if (!res.ok) {
      let message = `API ${path}: ${res.status}`;
      try {
        const body = await res.json();
        if (body.error) message = body.error;
      } catch { /* retain the HTTP fallback */ }
      throw new Error(message);
    }
    return res.json();
  }

  async function fetchStatus() {
    return apiFetch('/status');
  }

  async function fetchPools() {
    return apiFetch('/pools');
  }

  async function setModeApi(mode) {
    return apiFetch('/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
  }

  async function triggerScenario(name) {
    return apiFetch(`/scenario/${name}`, { method: 'POST' });
  }

  async function fetchScenarios() {
    return apiFetch('/scenarios');
  }

  async function fetchGeneratorStatus() {
    return apiFetch('/generate/status');
  }

  async function fetchLoadStatus() {
    return apiFetch('/load/status');
  }

  async function fetchAttribution() {
    return apiFetch('/attribution');
  }

  async function fetchCapabilities() { return apiFetch('/v1/capabilities'); }

  async function fetchTokenRateLimit() {
    return apiFetch(`/v1/token-rate-limit?state=${encodeURIComponent(tokenRateLimitState)}`);
  }

  function tokenPathHtml(item) {
    const labels = item.route?.hops || [];
    return `<div class="token-path ${item.admission === 'admitted' ? 'admitted' : 'stopped'}">${labels.map((label, index) => {
      const displayLabel = label === 'vllm-vcr' ? label : label.replaceAll('-', ' ');
      const chip = `<span class="token-path-chip">${escapeHtml(displayLabel)}</span>`;
      return index === labels.length - 1 ? chip : `${chip}<span class="token-path-edge" aria-hidden="true">→</span>`;
    }).join('')}</div>`;
  }

  function quotaValue(value) { return value === null || value === undefined ? '—' : String(value); }

  function renderTokenRateLimitResponse(response) {
    const panel = document.getElementById('token-rate-limit-panel');
    const empty = document.getElementById('token-rate-limit-empty');
    const content = document.getElementById('token-rate-limit-content');
    if (!panel || !empty || !content) return;
    panel.classList.toggle('hidden', !tokenRateLimitEnabled);
    if (!tokenRateLimitEnabled) return;
    const source = document.getElementById('token-rate-limit-source');
    const fixtureControls = document.getElementById('token-rate-limit-controls');
    const liveControls = document.getElementById('token-rate-limit-live-controls');
    const data = response?.data;
    if (!data) {
      content.classList.add('hidden');
      empty.classList.remove('hidden');
      empty.textContent = response?.warning || 'Token-rate-limit data is unavailable.';
      if (source) source.textContent = 'ENABLED · NO DATA';
      fixtureControls?.classList.toggle('hidden', tokenRateLimitLive);
      liveControls?.classList.toggle('hidden', !tokenRateLimitLive);
      return;
    }
    content.classList.remove('hidden');
    empty.classList.add('hidden');
    const live = response?.source === 'live' || data.source === 'live';
    if (source) source.textContent = live ? 'LIVE · OBSERVED REQUESTS' : 'SYNTHETIC FIXTURE';
    const eyebrow = document.querySelector('#token-rate-limit-panel .eyebrow');
    if (eyebrow) eyebrow.textContent = live ? 'Live distributed quota' : 'Opt-in quota demo';
    fixtureControls?.classList.toggle('hidden', live);
    liveControls?.classList.toggle('hidden', !live);
    const quota = data.quota;
    const summary = document.getElementById('token-rate-limit-summary');
    const summaryItems = [
      ['Principal', data.principal], ['Model', data.model], ['Quota key', quota.shared_key],
      ['Quota policy', `${quota.configured_limit ?? quota.limit ?? '—'} tokens / rolling ${quota.window_seconds === 60 ? '1 minute' : `${quota.window_seconds ?? '—'} seconds`}`],
      ['Backend', quota.backend],
    ];
    summary.innerHTML = summaryItems.map(([label, value]) => `<div class="token-summary-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`).join('');
    for (const provider of ['west', 'central', 'east']) {
      const count = data.provider_distribution?.[provider] || 0;
      const target = document.getElementById(`token-provider-${provider}-count`);
      if (target) target.textContent = `${count} ${count === 1 ? 'request' : 'requests'}`;
    }
    const rows = document.getElementById('token-rate-limit-requests');
    rows.innerHTML = data.requests.map(item => {
      const admitted = item.admission === 'admitted';
      const unavailable = item.admission === 'unavailable';
      const provider = item.route.provider_gateway || 'None — stopped at quota';
      const trace = item.trace?.jaeger_url ? `<a class="token-trace-link" href="${escapeHtml(item.trace.jaeger_url)}" target="_blank" rel="noreferrer">${escapeHtml(item.trace.trace_id.slice(0, 8))}…</a>` : '—';
      const quotaText = item.quota.limit === null || item.quota.limit === undefined
        ? (item.quota.actual_tokens === null ? 'No quota headers' : `${item.quota.actual_tokens} actual tokens`)
        : `${quotaValue(item.quota.remaining)} / ${item.quota.limit}`;
      const retry = item.quota.retry_after_seconds === null || item.quota.retry_after_seconds === undefined ? '' : `<small>Retry-After ${item.quota.retry_after_seconds}s</small>`;
      return `<tr><td>${item.sequence ?? '—'}</td><td><strong>${escapeHtml(item.principal)}</strong><small>${escapeHtml(item.model)}</small></td><td>${escapeHtml(item.consumer_gateway.replaceAll('-', ' '))}<small>Edge entry</small></td><td class="${admitted ? 'token-admitted' : 'token-denied'}">${admitted ? 'ADMITTED' : unavailable ? 'UNAVAILABLE' : 'DENIED'}${!admitted ? `<small class="token-no-hop">HTTP ${item.http.status} · no provider hop</small>` : ''}</td><td>${escapeHtml(quotaText)}${retry}</td><td>${escapeHtml(provider)}</td><td>${tokenPathHtml(item)}</td><td>${item.http.status}</td><td>${trace}</td></tr>`;
    }).join('') || '<tr><td colspan="9" class="empty-state">No live requests in this displayed session. Choose Consumer Gateway A or B above; admitted traffic will be load balanced across Provider West, Provider Central, and Provider East.</td></tr>';
  }

  async function sendTokenRateLimitRequest(consumer) {
    const status = document.getElementById('token-request-status');
    const controls = [...document.querySelectorAll('#token-rate-limit-live-controls button')];
    controls.forEach(button => { button.disabled = true; });
    if (status) status.textContent = `Sending through Consumer Gateway ${consumer.toUpperCase()}…`;
    try {
      const response = await apiFetch('/v1/token-rate-limit/requests', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consumer }),
      });
      renderTokenRateLimitResponse(response);
      if (status) status.textContent = `HTTP ${response.record.http.status} · Consumer Gateway ${consumer.toUpperCase()}`;
    } catch (error) {
      if (status) status.textContent = error.message;
    } finally {
      controls.forEach(button => { button.disabled = false; });
    }
  }

  async function clearTokenRateLimitResults() {
    const response = await apiFetch('/v1/token-rate-limit/requests', { method: 'DELETE' });
    renderTokenRateLimitResponse(response);
    const status = document.getElementById('token-request-status');
    if (status) status.textContent = 'Displayed results cleared; shared quota unchanged';
  }

  async function fetchRequests({ append = false } = {}) {
    const params = new URLSearchParams({ limit: '25' });
    const minutes = Number(document.getElementById('request-window')?.value || 15);
    params.set('from', new Date(Date.now() - minutes * 60 * 1000).toISOString());
    const provider = document.getElementById('request-provider')?.value;
    if (provider) params.set('provider', provider);
    if (append && requestCursor) params.set('cursor', requestCursor);
    const result = await apiFetch(`/v1/requests?${params}`);
    pendingRequestEvents = 0;
    const liveIndicator = document.getElementById('request-live-indicator');
    if (liveIndicator) liveIndicator.lastChild.textContent = ' Live stream connected';
    requestItems = append ? requestItems.concat(result.items || []) : (result.items || []);
    requestCursor = result.next_cursor;
    renderRequestExplorer(result);
    // Trace indexing is asynchronous. Re-render the request-run cards after
    // the live request page refresh so pending rows acquire their exact path,
    // provider, and trace inspection link without requiring another run.
    if (currentGeneratorJob) renderGeneratedResults(currentGeneratorJob);
  }

  function formatDuration(value) { return typeof value === 'number' ? `${Math.round(value)}ms` : '—'; }

  function experienceClass(label) { return `experience-${label || 'unknown'}`; }

  function renderRequestExplorer(result = {}) {
    const body = document.getElementById('request-body');
    if (!body) return;
      const historyExplainer = document.getElementById('request-history-explainer');
      if (historyExplainer) {
        historyExplainer.innerHTML = result.partial
        ? '<div><strong>What this table shows · SIMULATED</strong><span>Local fixture requests in the selected window. The list refreshes every 3 seconds and is not limited to the latest Generate Requests action.</span></div>'
        : '<div><strong>What this table shows · LIVE, OBSERVED TRAFFIC</strong><span>Requests found in the selected time window, including traffic from before or outside the latest Generate Requests action. The list refreshes every 3 seconds. GLB trace timing is routing/filter time; full request latency appears in Generated Request Results.</span></div>';
    }
    const query = (document.getElementById('request-search')?.value || '').toLowerCase();
    const replayPercent = Number(document.getElementById('history-scrubber')?.value || 100);
    const replayCount = Math.max(1, Math.ceil(requestItems.length * replayPercent / 100));
    const replayItems = requestItems.slice(0, replayCount);
    const visible = replayItems.filter(item => !query || JSON.stringify(item).toLowerCase().includes(query));
    const providerSelect = document.getElementById('request-provider');
    if (providerSelect) {
      const selectedProvider = providerSelect.value;
      const providers = [...new Set(requestItems.map(item => item.provider?.name || item.provider?.cluster).filter(Boolean))].sort();
      providerSelect.innerHTML = '<option value="">All providers</option>' + providers.map(provider => `<option value="${escapeHtml(provider)}">${escapeHtml(provider)}</option>`).join('');
      providerSelect.value = providers.includes(selectedProvider) ? selectedProvider : '';
    }
    body.innerHTML = visible.length ? visible.map(request => {
      const experience = request.experience || { label: 'unknown', score: null };
      const provider = request.provider?.name || request.provider?.cluster || 'unknown';
      const observedPath = request.services?.length
        ? request.services.map(service => service.replace(/^praxis-/, '')).join(' → ')
        : request.routing?.selection_tier || 'path unavailable';
      const route = request.routing?.failover ? ' ↪ failover' : '';
      const statusClass = request.status >= 400 || request.status === 0 ? 'status-bad' : 'status-good';
      return `<tr class="request-row" data-request-id="${escapeHtml(request.request_id)}" tabindex="0">
        <td class="request-time">${request.started_at ? new Date(request.started_at).toLocaleTimeString() : '—'}</td>
        <td><span class="experience-pill ${experienceClass(experience.label)}">${escapeHtml(experience.label)} <b>health ${experience.score ?? '—'}</b></span></td>
        <td><span class="status-pill ${statusClass}">${request.status || '—'}</span></td>
        <td><strong>${escapeHtml(provider)}</strong><small>${escapeHtml(observedPath)}${route}</small></td>
        <td>${formatDuration(request.ttft_ms)}</td><td>${formatDuration(request.duration_ms)}</td>
        <td>${request.routing?.score ?? '—'} <small>/ #${request.routing?.rank ?? '—'}</small></td>
        <td><span class="quality-label quality-${escapeHtml(request.trace_quality || 'unknown')}">${request.trace_quality === 'exact' ? 'EXACT TRACE' : escapeHtml(request.trace_quality || 'unknown')}</span></td>
        <td><button class="table-link request-open" type="button" data-request-id="${escapeHtml(request.request_id)}">Inspect</button></td>
      </tr>`;
    }).join('') : `<tr><td colspan="9" class="empty-state request-empty-state">${requestEmptyState()}</td></tr>`;
    body.querySelectorAll('.request-open').forEach(button => button.addEventListener('click', () => openRequestDetail(button.dataset.requestId)));
    body.querySelectorAll('.request-row').forEach(row => row.addEventListener('keydown', event => { if (event.key === 'Enter') openRequestDetail(row.dataset.requestId); }));
    const total = visible.length;
    const good = replayItems.filter(item => item.experience?.label === 'excellent' || item.experience?.label === 'good').length;
    const bad = replayItems.filter(item => item.experience?.label === 'poor' || item.status >= 400).length;
    const strip = document.getElementById('request-summary-strip');
    if (strip) strip.innerHTML = `<div><b>${total}</b><span>requests in window</span></div><div class="summary-good"><b>${good}</b><span>healthy experience</span></div><div class="summary-bad"><b>${bad}</b><span>needs attention</span></div><div><b>${result.partial ? 'SIMULATED' : 'LIVE'}</b><span>data quality</span></div>`;
    const page = document.getElementById('request-page-status');
    if (page) page.textContent = `${total} loaded${result.has_more ? ' · more available' : ''}`;
    const scrubberLabel = document.getElementById('history-scrubber-label');
    if (scrubberLabel) scrubberLabel.textContent = replayPercent === 100 ? 'All requests' : `Newest ${replayPercent}%`;
    const replayState = document.getElementById('replay-state');
    if (replayState) replayState.textContent = replayPercent === 100 ? `Showing ${replayItems.length} requests` : `Showing ${replayItems.length} of ${requestItems.length} requests`;
    const spotlight = document.getElementById('replay-spotlight');
    if (spotlight) {
      if (replayPercent === 100 || !replayItems.length) {
        spotlight.innerHTML = `<span>Replay is showing all ${replayItems.length} requests in this window.</span>`;
      } else {
        const current = replayItems[replayItems.length - 1];
        const provider = current.provider?.name || current.provider?.cluster || 'provider unavailable';
        const path = current.services?.length ? current.services.join(' → ') : provider;
        spotlight.innerHTML = `<strong>Replay position</strong><span>${escapeHtml(current.request_id)} · ${escapeHtml(path)} · HTTP ${current.status || '—'} · ${formatDuration(current.duration_ms)}</span><button class="table-link replay-inspect" type="button" data-request-id="${escapeHtml(current.request_id)}">Inspect this request</button>`;
        spotlight.querySelector('.replay-inspect')?.addEventListener('click', () => openRequestDetail(current.request_id));
      }
    }
    const older = document.getElementById('request-older');
    if (older) older.disabled = !requestCursor;
  }

  function requestEmptyState() {
    const environment = requestCapabilities?.environment;
    const generator = requestCapabilities?.capabilities?.can_generate_requests;
    if (environment?.mode === 'demo') {
      return 'No simulated requests in this window. Use Generate Requests below to create labeled local fixture traffic.';
    }
    if (generator?.state === 'available' || (!requestCapabilities && currentDataSource === 'glb')) {
      return 'No live requests observed in this window. Use Generate Requests below to send traffic through the configured gateway.';
    }
    return 'No request evidence is available in this window. Connect a live Grid source or explicitly enable simulation for local fixtures.';
  }

  function setReplayPosition(value) {
    const scrubber = document.getElementById('history-scrubber');
    if (!scrubber) return;
    scrubber.value = String(Math.max(10, Math.min(100, value)));
    renderRequestExplorer();
  }

  function stopReplay() {
    if (replayTimer) clearInterval(replayTimer);
    replayTimer = null;
    const button = document.getElementById('replay-play');
    if (button) button.textContent = 'Play';
  }

  function toggleReplay() {
    if (replayTimer) { stopReplay(); return; }
    const scrubber = document.getElementById('history-scrubber');
    if (!scrubber) return;
    if (Number(scrubber.value) >= 100) scrubber.value = '10';
    const button = document.getElementById('replay-play');
    if (button) button.textContent = 'Pause';
    replayTimer = setInterval(() => {
      const position = Number(scrubber.value) + 10;
      if (position >= 100) { setReplayPosition(100); stopReplay(); } else setReplayPosition(position);
    }, Number(document.getElementById('replay-speed')?.value || 700));
  }

  function renderRequestFlow(request) {
    const services = Array.isArray(request?.services) ? request.services.filter(Boolean) : [];
    const path = ['client', ...services, 'backend'];
    const nodes = path.map((service, index) => {
      const label = service === 'client' ? 'Client' : service === 'backend' ? 'Backend' : service.replace(/^praxis-/, '');
      const role = service === 'client' ? 'client' : service === 'backend' ? 'backend' : service.includes('gtm') ? 'gtm' : service.includes('edge') ? 'edge' : service.includes('provider') ? 'provider' : 'service';
      return `${index ? '<span class="request-flow-arrow" aria-hidden="true">→</span>' : ''}<div class="request-flow-node request-flow-${role} ${service === request?.provider?.cluster || service.includes(request?.provider?.cluster || '__none__') ? 'request-flow-selected' : ''}"><strong>${escapeHtml(label)}</strong><small>${service === 'client' || service === 'backend' ? 'boundary' : 'traced'}</small></div>`;
    }).join('');
    return `<section class="request-flow-detail"><div class="detail-section-heading"><h3>Request flow</h3><span>causal order from trace parentage</span></div><div class="request-flow-strip">${nodes || '<span class="empty-state">Observed path unavailable.</span>'}</div><p class="request-flow-caption">The arrows show the observed request path for this request. Boundary nodes are context; the middle nodes are the services that emitted trace spans.</p></section>`;
  }

  async function openRequestDetail(requestId) {
    const panel = document.getElementById('request-detail');
    const content = document.getElementById('request-detail-content');
    panel.classList.remove('hidden');
    content.innerHTML = '<div class="empty-state">Loading request evidence…</div>';
    try {
      const response = await apiFetch(`/v1/requests/${encodeURIComponent(requestId)}`);
      const request = response.request;
      document.getElementById('request-detail-title').textContent = `${request.request_id} · ${request.status || 'unknown'}`;
      const route = [request.provider?.site, request.provider?.cluster].filter(Boolean).join(' / ') || 'provider unavailable';
      const reasons = (request.experience?.reasons || []).map(reason => `<li>${escapeHtml(reason)}</li>`).join('');
      const spans = (request.spans || []).slice(0, 30).map(span => `<div class="span-row"><span>${escapeHtml(span.kind || 'SPAN')}</span><strong>${escapeHtml(span.operation || span.name || 'span')}</strong><em>${formatDuration((span.duration_us || 0) / 1000)}</em></div>`).join('') || '<div class="empty-state">Full span detail is not available for this source.</div>';
      const components = Object.entries(request.experience?.components || {}).map(([name, value]) => `<div class="component-row"><span>${escapeHtml(name.replace('_', ' '))}</span><b>${value}</b></div>`).join('');
      const selectionQueue = request.selection_time_metrics?.queue_depth;
      const selectionKv = request.selection_time_metrics?.kv_cache;
      const timingLabel = request.trace_quality === 'exact' ? 'Routing span' : 'Total';
      const rawTraceAction = request.jaeger_url
        ? `<a class="secondary-btn" href="${escapeHtml(request.jaeger_url)}" target="_blank" rel="noreferrer">Open raw trace</a>`
        : '<span class="secondary-btn disabled-action" role="status">Raw trace unavailable for this observation</span>';
      content.innerHTML = `<div class="request-detail-grid"><div class="detail-hero"><span class="experience-pill ${experienceClass(request.experience?.label)}">${escapeHtml(request.experience?.label || 'unknown')} · ${request.experience?.score ?? '—'}/100</span><p>${escapeHtml(request.experience?.reasons?.[0] || 'Experience evidence unavailable')}</p></div><div class="detail-fact"><span>Observed path</span><strong>${escapeHtml((request.services || []).join(' → ') || route)}</strong></div><div class="detail-fact"><span>Provider</span><strong>${escapeHtml(route)}</strong></div><div class="detail-fact"><span>Route decision</span><strong>${escapeHtml(request.routing?.decision || 'not observed')}</strong></div><div class="detail-fact"><span>Score / rank</span><strong>${request.routing?.score ?? '—'} / #${request.routing?.rank ?? '—'}</strong></div><div class="detail-fact"><span>Timing</span><strong>TTFT ${formatDuration(request.ttft_ms)} · ${timingLabel} ${formatDuration(request.duration_ms)}</strong></div></div>${renderRequestFlow(request)}<div class="detail-columns"><div><h3>Why this experience score?</h3><div class="component-list">${components}</div><ul class="reason-list">${reasons}</ul><p class="provenance-note">Quality: ${escapeHtml(request.trace_quality)} · ${escapeHtml(request.provenance?.routing || 'routing provenance unavailable')}</p><h3 class="selection-heading">Signals at selection</h3><p class="provenance-note">Queue ${selectionQueue ? `${selectionQueue.value} (${selectionQueue.quality})` : '—'} · KV ${selectionKv ? `${selectionKv.value} (${selectionKv.quality})` : '—'}</p></div><div><h3>Trace spans</h3><div class="span-list">${spans}</div></div></div><div class="detail-actions"><button class="primary-btn" id="replay-request" type="button" ${response.replay?.allowed ? '' : 'disabled'}>${response.replay?.allowed ? 'Replay safe synthetic request' : 'Replay unavailable'}</button>${rawTraceAction}<span>${response.replay?.reason ? escapeHtml(response.replay.reason) : 'No original prompt is reused.'}</span></div>`;
      document.getElementById('replay-request')?.addEventListener('click', async () => {
        const replay = await apiFetch('/v1/replays', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request_id: request.request_id }) });
        document.getElementById('replay-request').textContent = `Replay ${replay.replay.status}`;
      });
    } catch (error) { content.innerHTML = `<div class="empty-state">Unable to load request: ${escapeHtml(error.message)}</div>`; }
  }

  function renderCapabilities(capabilities) {
    requestCapabilities = capabilities;
    tokenRateLimitEnabled = capabilities?.features?.tokenRateLimit === true;
    tokenRateLimitLive = capabilities?.features?.tokenRateLimitLive === true;
    document.body.classList.toggle('token-rate-limit-profile', tokenRateLimitLive);
    document.getElementById('token-live-topology')?.classList.toggle('hidden', !tokenRateLimitLive);
    if (tokenRateLimitLive) {
      const title = document.querySelector('header h1');
      const subtitle = document.querySelector('header .subtitle');
      const sourceBadge = document.getElementById('source-badge');
      const evidenceBadge = document.getElementById('evidence-badge');
      if (title) title.textContent = 'Distributed Token Rate Limiting';
      if (subtitle) subtitle.textContent = 'Shared quota enforcement with Grid-aware provider routing';
      if (sourceBadge) { sourceBadge.textContent = 'TOKEN QUOTA'; sourceBadge.className = 'badge badge-source'; }
      if (evidenceBadge) { evidenceBadge.textContent = 'LIVE'; evidenceBadge.className = 'badge badge-live'; }
    }
    const chip = document.getElementById('capability-summary');
    if (!chip) return;
    const env = capabilities.environment;
    const generator = capabilities.capabilities.can_generate_requests;
    chip.textContent = tokenRateLimitLive
      ? 'Distributed token quota · LIVE TARGETS'
      : `${env.display_name} · ${generator.state === 'available' ? (env.mode === 'demo' ? 'SIMULATION ENABLED' : 'LIVE TARGET') : 'GENERATION UNAVAILABLE'}`;
    chip.className = `data-quality-chip ${env.mode === 'demo' ? 'simulated' : ''}`;
    if (tokenRateLimitEnabled) fetchTokenRateLimit().then(renderTokenRateLimitResponse).catch(error => renderTokenRateLimitResponse({ warning: error.message }));
    else renderTokenRateLimitResponse({});
  }

  function connectRequestEvents() {
    if (requestEventSource) requestEventSource.close();
    requestEventSource = new EventSource('/api/v1/events/stream');
    requestEventSource.onopen = () => document.getElementById('request-live-indicator')?.classList.add('connected');
    requestEventSource.onerror = () => document.getElementById('request-live-indicator')?.classList.remove('connected');
    requestEventSource.addEventListener('request.summary.created', () => {
      pendingRequestEvents += 1;
      const indicator = document.getElementById('request-live-indicator');
      if (indicator) indicator.lastChild.textContent = ` ${pendingRequestEvents} new request${pendingRequestEvents === 1 ? '' : 's'} buffered`;
      if (eventRefreshTimer) clearTimeout(eventRefreshTimer);
      eventRefreshTimer = setTimeout(() => fetchRequests().catch(() => null), 450);
    });
    requestEventSource.addEventListener('generation.progress', event => { const job = JSON.parse(event.data).job; updateGenerator(job); });
    requestEventSource.addEventListener('load.progress', event => { updateLoad(JSON.parse(event.data).job); });
    requestEventSource.addEventListener('load.finished', event => { updateLoad(JSON.parse(event.data).job); refreshAll().catch(() => null); });
  }

  window.startRequestGeneration = async function () {
    const payload = {
      count: Number(document.getElementById('generator-count').value),
      rate: Number(document.getElementById('generator-rate').value),
      target_pool: document.getElementById('generator-pool')?.value || 'pool-a',
      concurrency: Number(document.getElementById('generator-concurrency')?.value || 1),
      max_tokens: Number(document.getElementById('generator-max-tokens')?.value || 5),
      prompt: document.getElementById('generator-prompt').value,
    };
    hiddenGeneratorJobId = null;
    // Give the user immediate feedback while the request job is being
    // accepted. The POST can take long enough for a blank click to feel like
    // a failed action, especially when the live target is remote.
    updateGenerator({
      available: true,
      starting: true,
      target: currentDataSource === 'glb' && currentMode !== 'demo' ? 'glb-gateway' : 'simulated',
      job: currentGeneratorJob,
    });
    try {
      const response = await apiFetch('/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      lastGeneratorError = null;
      currentGeneratorJob = response.job;
      updateGenerator(response.job);
      await refreshAll();
    } catch (error) {
      lastGeneratorError = error.message;
      updateGenerator({ error: error.message });
    }
  };

  window.cancelRequestGeneration = async function () {
    await apiFetch('/generate/cancel', { method: 'POST' }).catch(() => {});
    await refreshAll();
  };

  window.startLoadGeneration = async function () {
    const payload = {
      target_pool: document.getElementById('load-pool').value,
      mode: document.getElementById('load-mode').value,
      duration_seconds: Number(document.getElementById('load-duration').value),
      rate: Number(document.getElementById('load-rate').value),
      concurrency: Number(document.getElementById('load-concurrency').value),
      max_tokens: Number(document.getElementById('load-max-tokens').value),
    };
    updateLoad({ available: true, starting: true, target: 'llmd-load' });
    try {
      const response = await apiFetch('/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      updateLoad(response.job);
      await refreshAll();
    } catch (error) {
      updateLoad({ available: false, error: error.message, target: 'llmd-load' });
    }
  };

  window.cancelLoadGeneration = async function () {
    await apiFetch('/load/cancel', { method: 'POST' }).catch(() => {});
    await refreshAll();
  };

  window.clearRequestResults = async function () {
    try {
      if (currentGeneratorJob?.running) return;
      hiddenGeneratorJobId = currentGeneratorJob?.id || null;
      currentGeneratorJob = null;
      lastGeneratorError = null;
      await refreshAll();
    } catch (error) {
      updateGenerator({ error: error.message, job: currentGeneratorJob, available: true, target: 'glb-gateway' });
    }
  };

  function updateGenerator(status, attribution) {
    const section = document.getElementById('request-generator');
    const start = document.getElementById('generator-start');
    const cancel = document.getElementById('generator-cancel');
    const badge = document.getElementById('generator-status');
    const targetStatus = document.getElementById('generator-target-status');
    const progress = document.getElementById('generator-progress');
    if (!section || !start || !cancel || !badge || !progress) return;
    const available = status?.available !== false;
    if (status?.available === true && !status?.error) lastGeneratorError = null;
    section.classList.remove('hidden');
    const description = section.querySelector('.request-generator-header p');
    if (description) description.textContent = status?.target === 'simulated'
      ? 'Generate safe local requests for the selected scenario. They never leave this host and are labeled SIMULATED.'
      : status?.target === 'glb-gateway'
        ? available
          ? 'Send real requests through the reachable Grid global load-balancer (GLB) gateway and watch each observed request path below.'
          : 'The Grid global load-balancer (GLB) target is configured, but its gateway is not reachable. Start the documented Kind environment before generating traffic.'
        : status?.target === 'combined-gateway'
          ? 'Live combined-site evidence is available, but this topology has no configured dashboard request generator.'
          : status?.target === 'llmd-gateway'
            ? 'Live llm-d/EPP evidence is available through the consumer gateway. Generate real requests and watch their observed attribution below.'
        : 'Request generation is visible here, but this live source has no configured target.';
    if (status?.job && status.job.id !== hiddenGeneratorJobId) currentGeneratorJob = status.job;
    const job = status?.job?.id === hiddenGeneratorJobId ? null : (status?.job || currentGeneratorJob);
    const error = status?.error || job?.error || lastGeneratorError;
    const starting = Boolean(status?.starting);
    const running = !!job?.running;
    start.disabled = !available || starting || running;
    cancel.classList.toggle('hidden', !running);
    badge.textContent = starting ? 'Starting' : running ? 'Running' : error ? 'Error' : !available ? 'Unavailable' : job ? 'Complete' : 'Ready';
    badge.className = `generator-status ${starting ? 'starting' : running ? 'running' : error ? 'error' : !available ? 'unavailable' : ''}`;
    if (targetStatus) {
      const targetName = status?.target === 'simulated' ? 'Local simulation' : status?.target === 'glb-gateway' ? 'Live Grid global load-balancer (GLB) gateway' : status?.target === 'combined-gateway' ? 'Combined-site request generator' : status?.target === 'llmd-gateway' ? 'Live llm-d consumer gateway' : 'Live request target';
      targetStatus.className = `generator-target-status ${status?.target === 'simulated' ? 'simulated' : available ? 'available' : 'unavailable'}`;
      targetStatus.innerHTML = available
        ? `<span class="target-dot"></span><div><strong>${targetName} is available</strong><span>${status?.target === 'simulated' ? 'Requests stay on this host and are labeled SIMULATED.' : 'The Generate button can send traffic now.'}</span></div>`
        : `<span class="target-dot"></span><div><strong>${targetName} is unavailable</strong><span>${escapeHtml(status?.reason || 'Start the documented environment, then refresh this page.')}</span></div>`;
    }
    if (starting) {
      progress.innerHTML = '<span class="generator-starting"><strong>Starting request generation…</strong> Creating the job and connecting to the selected target.</span>';
    } else if (error) {
      progress.innerHTML = `<span class="generator-error"><strong>Generation did not start.</strong> ${escapeHtml(error)}</span>`;
    } else if (!available) {
      progress.innerHTML = '<span class="generator-error">Generation is disabled until a request target is available.</span>';
    } else if (job) {
      progress.innerHTML =
        `<div class="generator-progress-grid">
            <div><strong>${job.completed}/${job.count}</strong><span>complete</span></div>
            <div class="success"><strong>${job.succeeded}</strong><span>succeeded</span></div>
            <div class="failed"><strong>${job.failed}</strong><span>failed</span></div>
            <div><strong>${running ? '…' : 'Done'}</strong><span>${running ? 'sending' : 'job status'}</span></div>
          </div>`;
    } else {
      progress.textContent = 'No requests generated yet.';
    }
    renderGeneratedResults(job);
    const attributionEl = document.getElementById('generator-attribution');
    if (attributionEl) {
      if (running) {
        attributionEl.textContent = 'Waiting for this run to produce trace attribution…';
      } else if (error) {
        attributionEl.textContent = 'No attribution: the request run did not start.';
      } else if (!attribution?.available || !attribution.sample_size) {
        attributionEl.textContent = 'No route attribution is available for this run yet.';
      } else {
        const entries = Object.entries(attribution.providers || {})
          .sort(([, a], [, b]) => b - a)
          .map(([provider, count]) => {
            const share = Math.round((count / attribution.sample_size) * 100);
            return `<div class="attribution-card">
              <div class="attribution-provider">${escapeHtml(provider)}</div>
              <div class="attribution-count">${count}</div>
              <div class="attribution-share">${share}% of observed traffic</div>
              <div class="attribution-bar"><span style="width:${share}%"></span></div>
            </div>`;
          }).join('');
        const runLabel = attribution.run_id ? ` · run ${escapeHtml(attribution.run_id)}` : '';
        attributionEl.innerHTML = `<div class="attribution-heading"><strong>Route attribution in the current trace window</strong><span>${attribution.sample_size} traced requests${runLabel} · not a per-request result</span></div><div class="attribution-grid">${entries || '<span>No provider selected</span>'}</div>`;
      }
    }
  }

  function updateLoad(status = {}) {
    const section = document.getElementById('llmd-load');
    if (!section) return;
    const isVcr = currentDataSource === 'vcr';
    section.classList.toggle('hidden', !isVcr);
    if (!isVcr) return;
    const start = document.getElementById('load-start');
    const cancel = document.getElementById('load-cancel');
    const badge = document.getElementById('load-status');
    const targetStatus = document.getElementById('load-target-status');
    const progress = document.getElementById('load-progress');
    const job = status.job || (status.target === 'llmd-load' && status.id ? status : null);
    const starting = Boolean(status.starting);
    const running = Boolean(job?.running);
    const available = status.available !== false && !status.error;
    start.disabled = !available || starting || running;
    cancel.classList.toggle('hidden', !running);
    badge.textContent = starting ? 'Starting' : running ? 'Running' : status.error ? 'Error' : job ? 'Complete' : !available ? 'Unavailable' : 'Ready';
    badge.className = `generator-status ${starting ? 'starting' : running ? 'running' : status.error ? 'error' : !available ? 'unavailable' : ''}`;
    if (targetStatus) {
      targetStatus.className = `generator-target-status ${available ? 'available' : 'unavailable'}`;
      targetStatus.innerHTML = available
        ? '<span class="target-dot"></span><div><strong>Dashboard process → selected llm-d consumer gateway</strong><span>This load is generated by the observability UI process, not a Kubernetes pressure-generator pod. Grid decides the provider for ordinary traffic.</span></div>'
        : `<span class="target-dot"></span><div><strong>llm-d load target unavailable</strong><span>${escapeHtml(status.error || status.reason || 'Start the llm-d pool metrics demo, then refresh.')}</span></div>`;
    }
    if (starting) {
      progress.innerHTML = '<span class="generator-starting"><strong>Starting sustained load…</strong> Finding the selected consumer gateway.</span>';
    } else if (status.error) {
      progress.innerHTML = `<span class="generator-error"><strong>Load did not start.</strong> ${escapeHtml(status.error)}</span>`;
    } else if (job) {
      const providers = Object.entries(job.providers || {}).sort(([, a], [, b]) => b - a).map(([name, count]) => `${escapeHtml(name)} ${count}`).join(' · ') || 'no attribution yet';
      const gateways = Object.entries(job.consumer_gateways || {}).sort(([, a], [, b]) => b - a).map(([name, count]) => `${escapeHtml(name)} ${count}`).join(' · ') || `target ${escapeHtml(job.target_pool || '—')} · awaiting response header`;
      const modeLabel = job.mode === 'sustained' ? 'sustained workers' : 'pulse batches';
      const ingressLabel = job.target_pool === 'pool-a' ? 'Pool A consumer gateway' : job.target_pool === 'pool-b' ? 'Pool B consumer gateway' : '—';
      progress.innerHTML = `<div class="load-progress-grid"><div><strong>${ingressLabel}</strong><span>pressure ingress target</span></div><div><strong>${modeLabel}</strong><span>pressure pattern</span></div><div><strong>${job.completed}</strong><span>requests sent</span></div><div class="success"><strong>${job.succeeded}</strong><span>HTTP success</span></div><div class="failed"><strong>${job.failed}</strong><span>failed</span></div><div><strong>${job.rate_per_second}</strong><span>requested req/sec</span></div></div><p class="load-attribution"><b>Ingress gateway (response header):</b> ${gateways}</p><p class="load-attribution"><b>Observed provider attribution:</b> ${providers}</p><p class="load-note">${running ? `Running ${modeLabel} for ${job.duration_seconds}s; this ingress gateway stays fixed while Grid may change the selected provider.` : `Finished: ${escapeHtml(job.stopped_reason || 'complete')}. This was the pressure ingress target, not a forced provider selection.`}</p>`;
    } else {
      progress.textContent = 'No sustained load running.';
    }
  }

  function renderLoadEppDetails(gatewayViews = []) {
    const container = document.getElementById('load-epp-details');
    if (!container || currentDataSource !== 'vcr') return;
    if (!gatewayViews.some(view => view.providers?.length)) {
      container.innerHTML = '<div class="load-epp-empty">EPP details are unavailable until live llm-d metrics are discovered.</div>';
      return;
    }
    const renderRows = providers => [...providers].sort((a, b) => {
      const rankA = typeof a.rank === 'number' ? a.rank : Number.MAX_SAFE_INTEGER;
      const rankB = typeof b.rank === 'number' ? b.rank : Number.MAX_SAFE_INTEGER;
      return rankA - rankB || String(a.site || a.cluster || '').localeCompare(String(b.site || b.cluster || ''));
    }).map(provider => {
      const site = provider.site || provider.cluster || provider.name || 'unknown';
      const displaySite = site === 'pool-a' ? 'Pool A' : site === 'pool-b' ? 'Pool B' : site;
      const queue = provider.queue_depth?.value ?? provider.queue_depth;
      const rawQueue = provider.queue_depth?.raw_value;
      const capacity = provider.queue_depth?.capacity;
      const kv = provider.kv_cache?.value ?? provider.kv_cache;
      const queueText = typeof queue === 'number' ? `${queue.toFixed(2)}${typeof capacity === 'number' ? ` / ${capacity}` : ''}` : '—';
      const rawText = typeof rawQueue === 'number' ? `raw ${rawQueue}` : '';
      const kvText = typeof kv === 'number' ? `${Math.round(kv * 100)}%` : '—';
      const score = typeof provider.score === 'number' ? provider.score.toFixed(2) : '—';
      const rank = typeof provider.rank === 'number' ? `#${provider.rank}` : '—';
      const fresh = provider.queue_depth?.fresh === false || provider.kv_cache?.fresh === false ? 'stale' : 'fresh';
      return `<tr><td><strong>${escapeHtml(displaySite)}</strong><small>${escapeHtml(site)} · ${escapeHtml(provider.cluster || provider.name || '')}</small></td><td>${rank}</td><td>${queueText}<small>${rawText}</small></td><td>${kvText}</td><td><span class="pressure-badge ${pressureClass(provider.pressure_level || 'unknown')}">${pressureLabel(provider.pressure_level || 'unknown')}</span></td><td>${score}</td><td><span class="epp-freshness epp-${fresh}">${fresh}</span></td></tr>`;
    }).join('');
    const tables = gatewayViews.filter(view => view.providers?.length).map(view => `<section class="load-epp-perspective"><h4>${escapeHtml(view.label)} consumer gateway routing view</h4><p>Higher score wins. If scores tie, this consumer gateway’s locality and other tie-breakers determine rank.</p><div class="load-epp-table-wrap"><table class="load-epp-table"><thead><tr><th>Provider / site</th><th>Rank</th><th>Queue / capacity</th><th>KV cache</th><th>Pressure</th><th>Score</th><th>Metric state</th></tr></thead><tbody>${renderRows(view.providers)}</tbody></table></div></section>`).join('');
    container.innerHTML = `<div class="load-epp-heading"><div><strong>EPP details · both consumer gateway perspectives</strong><span>Each table shows the live EPP signals and routing order seen by that consumer gateway. Provider gateways receive the selected request; they do not choose the winner.</span></div><span>Refreshes every 3s</span></div>${tables}`;
  }

  function renderGeneratedResults(job) {
    const container = document.getElementById('generator-results');
    if (!container) return;
    const results = job?.results || [];
    if (!results.length) {
      container.innerHTML = `<div class="generator-results-empty">${job?.running ? 'Waiting for the first generated response…' : 'No generated job results yet. Start Generate Requests above; each response will appear here.'}</div>`;
      return;
    }
    const rows = results.map((result, index) => {
      const resultTime = new Date(result.started_at || 0).getTime();
      const match = result.request_id
        ? requestItems.find(item => item.request_id === result.request_id)
        : requestItems
          .filter(item => item.started_at)
          // Do not bind a request card to a partially indexed trace. A live
          // trace can briefly contain only the entry/service span; waiting
          // keeps the card truthful instead of showing an incomplete path or
          // an unknown provider.
          .filter(item => item.services?.length >= 2 && item.provider?.cluster && item.provider.cluster !== 'unknown')
          .map(item => ({ item, distance: Math.abs(new Date(item.started_at).getTime() - resultTime) }))
          .filter(candidate => candidate.distance <= 10_000)
          .sort((a, b) => a.distance - b.distance)[0]?.item;
      const traceId = result.trace_id || match?.trace_id;
      const provider = result.provider || match?.provider?.name || match?.provider?.cluster;
      const path = match?.services?.length ? match.services.join(' → ') : result.route || 'Route pending trace indexing';
      const status = result.status || match?.status || 0;
      const ok = result.ok ?? (status >= 200 && status < 400);
      return `<div class="generated-result ${ok ? 'result-ok' : 'result-failed'}">
        <div class="generated-result-number">#${result.sequence || results.length - index}</div>
        <div class="generated-result-main"><strong>${ok ? 'Completed' : 'Failed'} · HTTP ${status || '—'}</strong><span>${escapeHtml(path)}</span></div>
        <div class="generated-result-route"><span>Provider</span><b>${escapeHtml(provider || 'Awaiting trace')}</b></div>
        <div class="generated-result-route"><span>Latency</span><b>${formatDuration(result.duration_ms || match?.duration_ms)}</b></div>
        ${traceId
          ? `<button class="table-link generated-result-open" type="button" data-request-id="${escapeHtml(result.request_id || match?.request_id || '')}">Inspect</button>`
          : job.target === 'llmd-gateway'
            ? '<span class="generated-result-pending">Gateway attribution captured</span>'
            : '<span class="generated-result-pending">Trace indexing…</span>'}
      </div>`;
    }).join('');
    const runType = job.target === 'simulated' ? 'SIMULATED · local fixture traffic' : 'LIVE · gateway responses';
    const runId = job.id ? ` · ${escapeHtml(job.id)}` : '';
    container.innerHTML = `<div class="generator-results-heading"><div><strong>Results from: Generated request results</strong><p>Responses from the Generate Requests job above: ${runType}${runId}. These are not the full observed history table.</p></div><div class="generator-results-actions"><span>${results.length} of ${job.count} returned · newest first</span><button id="generator-clear" class="secondary-btn" type="button" ${job.running ? 'disabled' : ''}>Clear results</button></div></div>${rows}`;
    container.querySelectorAll('.generated-result-open').forEach(button => button.addEventListener('click', () => openRequestDetail(button.dataset.requestId)));
    container.querySelector('#generator-clear')?.addEventListener('click', clearRequestResults);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    }[character]));
  }

  // -----------------------------------------------------------------------
  // Mode
  // -----------------------------------------------------------------------

  window.setMode = async function (mode) {
    currentMode = mode;
    await setModeApi(mode);
    updateModeButtons();
    await refreshAll();
  };

  window.setDataSource = async function (source) {
    if (currentDataSource !== source) {
      currentGeneratorJob = null;
      hiddenGeneratorJobId = null;
    }
    currentDataSource = source;
    await apiFetch('/source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source }),
    }).catch(() => {});
    updateSourceButtons();
    await refreshAll();
  };

  function updateModeButtons() {
    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.id === `btn-${currentMode}`);
    });
  }

  function updateSourceButtons() {
    if (tokenRateLimitLive) return;
    document.querySelectorAll('.source-btn').forEach(btn => {
      btn.classList.toggle('active', btn.id === `btn-src-${currentDataSource}`);
    });
    const badge = document.getElementById('source-badge');
    if (badge) {
      badge.className = 'badge';
      if (currentDataSource === 'vcr') {
        badge.textContent = 'llm-d/EPP';
        badge.classList.add('badge-source-vcr');
      } else if (currentDataSource === 'combined') {
        badge.textContent = 'COMBINED';
        badge.classList.add('badge-source');
      } else {
        badge.textContent = 'GLB';
        badge.classList.add('badge-source');
      }
    }
  }

  function updateModeBadge(status) {
    if (tokenRateLimitLive) return;
    const badge = document.getElementById('evidence-badge');
    if (!badge) return;
    effectiveMode = status.mode;

    if (status.source_label === 'UNAVAILABLE' && currentDataSource !== 'combined') {
      badge.className = 'badge badge-unavailable';
      badge.textContent = 'UNAVAILABLE';
      return;
    }

    badge.className = 'badge';
    if (currentDataSource === 'vcr') {
      if (status.mode === 'demo') {
        badge.textContent = 'SIMULATION ENABLED';
        badge.classList.add('badge-demo');
      } else {
        badge.textContent = status.vcr_mode === 'live' ? 'LIVE EPP METRICS' : status.vcr_mode === 'evidence' ? 'EVIDENCE FILE' : 'UNAVAILABLE';
        badge.classList.add(status.vcr_mode === 'live' ? 'badge-live' : 'badge-unknown');
      }
      return;
    }
    switch (status.mode) {
      case 'live':
        if (status.live_detail === 'praxis') {
          badge.textContent = 'LIVE EVIDENCE';
          badge.classList.add('badge-live-praxis');
        } else if (status.live_detail === 'synthetic') {
          badge.textContent = 'LIVE SYNTHETIC TRACE';
          badge.classList.add('badge-live-synthetic');
        } else {
        badge.textContent = 'LIVE EVIDENCE';
          badge.classList.add('badge-live');
        }
        break;
      case 'demo':
        badge.textContent = 'SIMULATION ENABLED';
        badge.classList.add('badge-demo');
        break;
      case 'unavailable':
        badge.textContent = 'UNAVAILABLE';
        badge.classList.add('badge-unavailable');
        break;
      default:
        badge.textContent = status.mode.toUpperCase();
        badge.classList.add('badge-unknown');
    }
  }

  // -----------------------------------------------------------------------
  // Scenario bar
  // -----------------------------------------------------------------------

  async function initScenarioBar() {
    const data = await fetchScenarios();
    const container = document.getElementById('scenario-buttons');
    container.innerHTML = '';

    data.scenarios.forEach(s => {
      const btn = document.createElement('button');
      btn.className = 'scenario-btn';
      btn.dataset.scenario = s.key;
      btn.textContent = s.label;
      btn.title = s.description;
      btn.addEventListener('click', async () => {
        await triggerScenario(s.key);
        updateActiveScenario(s.key, s.description);
        await refreshAll();
      });
      container.appendChild(btn);
    });
  }

  function updateActiveScenario(name, description) {
    document.querySelectorAll('.scenario-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.scenario === name);
    });
    const desc = document.getElementById('scenario-desc');
    if (desc && description) desc.textContent = description;
  }

  function toggleScenarioBar(visible) {
    const bar = document.getElementById('scenario-bar');
    bar.classList.toggle('hidden', !visible);
  }

  // -----------------------------------------------------------------------
  // Pool cards
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Pressure classification
  // -----------------------------------------------------------------------

  function pressureLevel(value) {
    if (typeof value !== 'number' || !isFinite(value)) return 'unknown';
    if (value < 0.50) return 'normal';
    if (value < 0.80) return 'elevated';
    if (value < 0.95) return 'high';
    return 'critical';
  }

  function pressureClass(level) {
    return `pressure-${level || 'unknown'}`;
  }

  function pressureLabel(level) {
    return (level || 'UNKNOWN').toUpperCase();
  }

  function pressureBarColor(level) {
    switch (level) {
      case 'normal': return 'var(--accent-green)';
      case 'elevated': return 'var(--accent-yellow)';
      case 'high': return 'var(--accent-orange, #f97316)';
      case 'critical': return 'var(--accent-red)';
      default: return 'var(--text-muted)';
    }
  }

  function formatMetric(value, unit) {
    if (typeof value !== 'number') return '—';
    if (unit === 'ratio' || unit === 'normalized_ratio') return Math.round(value * 100) + '%';
    return value.toFixed(2);
  }

  function formatScore(score) {
    return typeof score === 'number' ? score.toFixed(2) : '—';
  }

  function poolKey(pool) {
    return pool.stable_id || pool.cluster || pool.name || 'unknown';
  }

  function changeInfo(key, value, formatter) {
    const previous = previousPoolSnapshot.get(key);
    if (!previous || typeof value !== 'number' || typeof previous.value !== 'number' || value === previous.value) {
      return { className: '', delta: '' };
    }
    const delta = value - previous.value;
    const direction = delta > 0 ? 'up' : 'down';
    return {
      className: `value-changed value-changed-${direction}`,
      delta: `<span class="value-delta ${direction}">${delta > 0 ? '↑' : '↓'} ${formatter(delta)}</span>`,
    };
  }

  function percentDelta(delta) {
    return `${delta > 0 ? '+' : ''}${Math.round(delta * 100)} pts`;
  }

  function scoreDelta(delta) {
    return `${delta > 0 ? '+' : ''}${delta.toFixed(2)}`;
  }

  // -----------------------------------------------------------------------
  // Provider cards (data-driven, no hardcoded names)
  // -----------------------------------------------------------------------

  function renderPoolCards(pools, latestTrace) {
    const container = document.getElementById('pool-cards');
    if (!container) return;
    if (!Array.isArray(pools) || pools.length === 0) {
      container.innerHTML = '<div class="empty-state provider-unavailable">No provider data. Connect a live Grid source or explicitly enable simulation for local fixtures.</div>';
      return;
    }
    const selectedCluster = latestTrace?.selected_cluster;
    const selectedStableId = latestTrace?.stable_id;

    container.innerHTML = pools.map(pool => {
      const isSelected = (pool.stable_id && pool.stable_id === selectedStableId)
        || (pool.cluster && pool.cluster === selectedCluster)
        || (pool.name && latestTrace?.selected_provider?.includes(pool.name))
        || (!latestTrace && pool.rank === 0);
      const healthClass = pool.healthy === false ? ' unhealthy' : '';
      const selectedClass = isSelected ? ' selected' : '';
      const pLevel = pool.pressure_level || pressureLevel(
        typeof pool.queue_depth === 'number' ? pool.queue_depth
        : typeof pool.kv_cache === 'number' ? pool.kv_cache
        : null
      );
      const pValue = typeof pool.queue_depth === 'number' ? pool.queue_depth
        : typeof pool.kv_cache === 'number' ? pool.kv_cache
        : null;
      const pPercent = typeof pValue === 'number' ? Math.round(pValue * 100) : null;
      const routeState = isSelected ? 'Selected' : pool.healthy === false ? 'Unhealthy' : 'Candidate';
      const displayName = pool.cluster || pool.name || '—';
      const siteLabel = pool.site || pool.region || '—';
      const idLabel = pool.stable_id ? pool.stable_id.substring(0, 8) : '—';
      const tierLabel = pool.selection_tier || '—';
      const admissionLabel = pool.admission_state || '—';
      const metricSourceLabel = currentDataSource === 'vcr' ? 'EPP sample' : 'not collected here';
      const scoreStrategy = lastPoolData?.scoring_strategy || 'Grid policy';
      const scoreBreakdown = pool.score_breakdown
        ? Object.entries(pool.score_breakdown).filter(([, value]) => typeof value === 'number').map(([name, value]) => `${name.replaceAll('_', ' ')} ${value >= 0 ? '+' : ''}${value.toFixed(2)}`).join(' · ')
        : '';
      const key = poolKey(pool);
      const queueChange = changeInfo(`${key}:queue`, typeof pool.queue_depth === 'number' ? pool.queue_depth : null, percentDelta);
      const scoreChange = changeInfo(`${key}:score`, typeof pool.score === 'number' ? pool.score : null, scoreDelta);
      const rankChange = changeInfo(`${key}:rank`, typeof pool.rank === 'number' ? pool.rank : null, delta => `${Math.abs(Math.round(delta))} place`);
      const rankLabel = typeof pool.rank === 'number'
        ? (pool.rank === -1 ? 'Unhealthy' : `#${pool.rank + 1}`)
        : '—';

      return `
        <div class="pool-card${selectedClass}${healthClass} ${pressureClass(pLevel)}" data-pool="${displayName}" onclick="inspectProvider('${displayName}')" style="cursor:pointer">
          <div class="pool-header">
            <span class="pool-name">${displayName}</span>
            <div class="pool-badges">
              <span class="pressure-badge ${pressureClass(pLevel)}">${pressureLabel(pLevel)}</span>
              <span class="pool-rank-badge">${rankLabel}</span>
            </div>
          </div>
          <div class="pool-identity">
            <span>${siteLabel} · ${idLabel}</span>
            <span class="route-state ${routeState.toLowerCase()}">${routeState}</span>
          </div>
          <div class="pool-metrics">
            ${typeof pValue === 'number' ? `
            <div class="metric">
              <span class="metric-label">Pressure</span>
              <span class="metric-value">${pPercent}%</span>
              <div class="metric-bar">
                <div class="metric-bar-fill" style="width: ${pPercent}%; background: ${pressureBarColor(pLevel)}"></div>
              </div>
            </div>` : `
            <div class="metric">
              <span class="metric-label">Pressure</span>
              <span class="metric-value pressure-unknown">—</span>
              <div class="metric-bar"><div class="metric-bar-fill metric-bar-unavailable"></div></div>
            </div>`}
            <div class="metric ${queueChange.className}">
              <span class="metric-label">Queue <em>${metricSourceLabel}</em></span>
              <span class="metric-value">${formatMetric(pool.queue_depth, 'ratio')} ${queueChange.delta}</span>
            </div>
            <div class="metric">
              <span class="metric-label">KV Cache <em>${metricSourceLabel}</em></span>
              <span class="metric-value">${formatMetric(pool.kv_cache, 'ratio')}</span>
            </div>
            <div class="metric">
              <span class="metric-label">Tier</span>
              <span class="metric-value">${tierLabel}</span>
            </div>
          </div>
          <div class="pool-score-section">
            <div class="score-block ${scoreChange.className}">
              <span class="pool-score-label">Grid routing score <small>higher wins · ${scoreStrategy}</small></span>
              <div class="pool-score-value">${formatScore(pool.score)} ${scoreChange.delta}</div>
              <div class="pool-score-explanation">${scoreBreakdown || 'The active Grid policy did not expose component contributions.'}</div>
            </div>
            <div class="pool-admission">${admissionLabel}</div>
            ${rankChange.delta ? `<div class="rank-change ${rankChange.className}">${rankChange.delta}</div>` : ''}
            ${typeof pool.request_count === 'number' ? `<div class="pool-traffic">${pool.request_count} req</div>` : ''}
          </div>
        </div>
      `;
    }).join('');

    const nextSnapshot = new Map();
    pools.forEach(pool => {
      const key = poolKey(pool);
      nextSnapshot.set(`${key}:queue`, { value: pool.queue_depth });
      nextSnapshot.set(`${key}:score`, { value: pool.score });
      nextSnapshot.set(`${key}:rank`, { value: pool.rank });
    });
    previousPoolSnapshot = nextSnapshot;
  }

  // -----------------------------------------------------------------------
  // Topology view
  // -----------------------------------------------------------------------

  function renderTopology(pools, latestTrace) {
    const container = document.getElementById('topology');
    if (!container) return;

    const selectedCluster = latestTrace?.selected_cluster;
    const services = latestTrace?.services || [];
    const hasGtmSpan = services.some(s => s.includes('gtm'));

    const nodes = [
      { id: 'client', label: 'Client', role: 'client', traced: false, status: 'functional' },
      { id: 'gtm', label: 'GTM', role: 'gtm', traced: hasGtmSpan, status: hasGtmSpan ? 'traced' : 'functional' },
    ];

    const edgeServices = services.filter(s => s.includes('edge'));
    const providerServices = services.filter(s => s.includes('provider'));
    const edgeName = edgeServices[0] || 'edge';
    const hasEdgeSpan = edgeServices.length > 0;

    nodes.push({ id: 'edge', label: edgeName.replace('praxis-', ''), role: 'edge', traced: hasEdgeSpan, status: hasEdgeSpan ? 'traced' : 'functional' });

    const providerNodes = pools.map(p => {
      const name = p.cluster || p.name;
      const isSelected = name === selectedCluster
        || (p.stable_id && p.stable_id === latestTrace?.stable_id)
        || (!latestTrace && p.rank === 0);
      const isTraced = providerServices.some(s => name.includes(s.replace('praxis-', '')) || s.includes(name.replace('sim-', '')));
      const pLevel = p.pressure_level || pressureLevel(
        typeof p.queue_depth === 'number' ? p.queue_depth : null
      );
      return {
        id: name,
        label: name.replace('sim-', ''),
        role: 'provider',
        traced: isTraced,
        selected: isSelected,
        pressure: pLevel,
        status: isTraced ? 'traced' : isSelected ? 'functional' : 'eligible',
      };
    });

    nodes.push(...providerNodes);
    nodes.push({ id: 'backend', label: 'Backend', role: 'backend', traced: false, status: 'functional' });

    container.innerHTML = nodes.map(n => {
      const classes = ['topo-node', `topo-${n.role}`];
      if (n.selected) classes.push('topo-selected');
      if (n.traced) classes.push('topo-traced');
      if (n.pressure) classes.push(pressureClass(n.pressure));
      const statusLabel = n.traced ? 'traced' : n.status === 'functional' ? 'functional' : 'eligible';
      const statusClass = `topo-status-${statusLabel}`;
      return `<div class="${classes.join(' ')}">
        <span class="topo-label">${n.label}</span>
        <span class="topo-status ${statusClass}">${statusLabel}</span>
      </div>`;
    }).join('<span class="topo-arrow">→</span>');
  }

  // -----------------------------------------------------------------------
  // Provider inspector
  // -----------------------------------------------------------------------

  let lastPoolData = null;

  window.closeInspector = function () {
    document.getElementById('provider-inspector').classList.add('hidden');
  };

  window.inspectProvider = function (poolName) {
    if (!lastPoolData) return;
    const searchList = lastPoolData.providers || lastPoolData.pools || [];
    const pool = searchList.find(p =>
      (p.cluster || p.name) === poolName || p.stable_id === poolName);
    if (!pool) return;

    const panel = document.getElementById('provider-inspector');
    const content = document.getElementById('inspector-content');
    panel.classList.remove('hidden');

    const displayName = pool.cluster || pool.name || '—';
    const pLevel = pool.pressure_level || pressureLevel(
      typeof pool.queue_depth === 'number' ? pool.queue_depth : null);
    const pSource = pool.pressure_source || (typeof pool.queue_depth === 'number' ? 'queue_depth'
      : typeof pool.kv_cache === 'number' ? 'kv_cache' : null);
    const scoringStrategy = lastPoolData.scoring_strategy || 'unknown';

    content.innerHTML = `
      <div class="inspector-section">
        <div class="inspector-section-title">Identity</div>
        <div class="inspector-row"><span class="inspector-key">Provider</span><span class="inspector-val">${displayName}</span></div>
        <div class="inspector-row"><span class="inspector-key">Site</span><span class="inspector-val">${pool.site || pool.region || '—'}</span></div>
        <div class="inspector-row"><span class="inspector-key">Stable ID</span><span class="inspector-val mono">${pool.stable_id || '—'}</span></div>
        <div class="inspector-row"><span class="inspector-key">Cluster</span><span class="inspector-val">${pool.cluster || '—'}</span></div>
      </div>
      <div class="inspector-section">
        <div class="inspector-section-title">Pressure</div>
        <div class="inspector-row"><span class="inspector-key">Level</span><span class="inspector-val"><span class="pressure-badge ${pressureClass(pLevel)}">${pressureLabel(pLevel)}</span></span></div>
        <div class="inspector-row"><span class="inspector-key">Value</span><span class="inspector-val">${typeof pool.pressure_value === 'number' ? formatMetric(pool.pressure_value, 'ratio') : '—'}</span></div>
        <div class="inspector-row"><span class="inspector-key">Source signal</span><span class="inspector-val mono">${pSource || 'none'}</span></div>
        <div class="inspector-row"><span class="inspector-key">Classification</span><span class="inspector-val">demo thresholds</span></div>
      </div>
      <div class="inspector-section">
        <div class="inspector-section-title">Raw Signals</div>
        ${renderSignalRow('queue_depth', pool.queue_depth, 'normalized_ratio', scoringStrategy, pool.queue_depth_raw)}
        ${renderSignalRow('kv_cache_utilization', pool.kv_cache, 'ratio', scoringStrategy)}
      </div>
      <div class="inspector-section">
        <div class="inspector-section-title">Routing</div>
        <div class="inspector-row"><span class="inspector-key">Score</span><span class="inspector-val">${formatScore(pool.score)}</span></div>
        <div class="inspector-row"><span class="inspector-key">Rank</span><span class="inspector-val">${typeof pool.rank === 'number' ? (pool.rank === -1 ? 'Unhealthy' : '#' + (pool.rank + 1)) : '—'}</span></div>
        <div class="inspector-row"><span class="inspector-key">Admission</span><span class="inspector-val">${pool.admission_state || '—'}</span></div>
        <div class="inspector-row"><span class="inspector-key">Tier</span><span class="inspector-val">${pool.selection_tier || '—'}</span></div>
        <div class="inspector-row"><span class="inspector-key">Healthy</span><span class="inspector-val">${pool.healthy === false ? 'No' : pool.healthy === true ? 'Yes' : '—'}</span></div>
        <div class="inspector-row"><span class="inspector-key">Requests</span><span class="inspector-val">${typeof pool.request_count === 'number' ? pool.request_count : '—'}</span></div>
      </div>
      ${pool.score_breakdown ? `
      <div class="inspector-section">
        <div class="inspector-section-title">Score Breakdown</div>
        ${Object.entries(pool.score_breakdown).map(([k, v]) => `
          <div class="inspector-row">
            <span class="inspector-key mono">${k}</span>
            <span class="inspector-val ${v === 0 && scoringStrategy === 'noMetrics' ? 'pressure-unknown' : ''}">${typeof v === 'number' ? v.toFixed(2) : '—'}${v === 0 && scoringStrategy === 'noMetrics' ? ' (no weight)' : ''}</span>
          </div>
        `).join('')}
      </div>` : ''}
      <div class="inspector-section">
        <div class="inspector-section-title">Provenance</div>
        <div class="inspector-row"><span class="inspector-key">Scoring strategy</span><span class="inspector-val mono">${scoringStrategy}</span></div>
        <div class="inspector-row"><span class="inspector-key">Score source</span><span class="inspector-val">${scoringStrategy === 'noMetrics' ? 'policy ordering' : 'calculated by Grid'}</span></div>
        <div class="inspector-row"><span class="inspector-key">Raw values</span><span class="inspector-val">${pSource ? 'observed metric' : 'unavailable'}</span></div>
        <div class="inspector-row"><span class="inspector-key">Route</span><span class="inspector-val">gateway attribution</span></div>
        <div class="inspector-row"><span class="inspector-key">Trace</span><span class="inspector-val">Jaeger</span></div>
      </div>
    `;
  };

  function renderSignalRow(name, value, unit, scoringStrategy, rawValue) {
    const active = (scoringStrategy === 'queueDepth' && name === 'queue_depth')
      || (scoringStrategy === 'kvCachePressure' && name === 'kv_cache_utilization');
    const usedLabel = active ? '' : '<span class="inspector-inactive">not used for score</span>';
    if (typeof value !== 'number') {
      return `
        <div class="inspector-signal">
          <div class="inspector-row"><span class="inspector-key mono">${name}</span><span class="inspector-val pressure-unknown">unavailable</span></div>
          <div class="inspector-row"><span class="inspector-key">Unit</span><span class="inspector-val">${unit}</span></div>
          ${usedLabel ? `<div class="inspector-row">${usedLabel}</div>` : ''}
        </div>`;
    }
    return `
      <div class="inspector-signal">
        <div class="inspector-row"><span class="inspector-key mono">${name}</span><span class="inspector-val">${formatMetric(value, unit)}</span></div>
        <div class="inspector-row"><span class="inspector-key">Unit</span><span class="inspector-val">${unit}</span></div>
        <div class="inspector-row"><span class="inspector-key">Raw value</span><span class="inspector-val mono">${typeof rawValue === 'number' ? `${rawValue} requests` : value}</span></div>
        ${usedLabel ? `<div class="inspector-row">${usedLabel}</div>` : ''}
      </div>`;
  }

  // -----------------------------------------------------------------------
  // Causal pressure chain
  // -----------------------------------------------------------------------

  function renderCausalChain(providers, latestTrace, timelineEvents, scoringStrategy) {
    const container = document.getElementById('causal-chain');
    if (!container) return;
    if (!providers || providers.length === 0) {
      container.innerHTML = '<div class="empty-state">Waiting for provider data...</div>';
      return;
    }

    const selected = providers.find(p =>
      p.rank === 0 || (latestTrace && (
        (p.cluster || p.name) === latestTrace.selected_cluster ||
        p.stable_id === latestTrace?.stable_id
      ))
    ) || providers[0];

    const selectedName = selected.cluster || selected.name;
    const qd = typeof selected.queue_depth === 'number' ? selected.queue_depth
      : selected.queue_depth?.value;
    const kv = typeof selected.kv_cache === 'number' ? selected.kv_cache
      : selected.kv_cache?.value;
    const pLevel = selected.pressure_level || pressureLevel(qd ?? kv ?? null);
    const stepClass = pLevel === 'critical' ? 'step-critical'
      : pLevel === 'high' ? 'step-warning'
      : pLevel === 'elevated' ? 'step-warning'
      : 'step-ok';

    const hasRouteChange = timelineEvents?.some(e => e.type === 'route_change');
    const routeEvent = timelineEvents?.find(e => e.type === 'route_change');
    const attrEvent = timelineEvents?.find(e => e.type === 'attribution');

    const strategy = scoringStrategy || 'unknown';
    const strategyLabel = strategy === 'queueDepth' ? 'Queue Depth'
      : strategy === 'kvCachePressure' ? 'KV Cache'
      : strategy === 'noMetrics' ? 'No Metrics'
      : strategy === 'demo' ? 'Demo (Queue Depth)'
      : strategy;

    const isPolicyOnlyView = strategy === 'noMetrics';
    const trafficDetail = isPolicyOnlyView
      ? 'Requests distributed across active paths'
      : hasRouteChange ? 'Load triggered route change' : 'Steady state';
    const trafficClass = isPolicyOnlyView ? 'step-ok' : hasRouteChange ? 'step-warning' : 'step-ok';

    const metricLines = providers.map(p => {
      const name = p.cluster || p.name;
      const q = typeof p.queue_depth === 'number' ? p.queue_depth : p.queue_depth?.value;
      const k = typeof p.kv_cache === 'number' ? p.kv_cache : p.kv_cache?.value;
      const pl = p.pressure_level || pressureLevel(q ?? k ?? null);
      if (isPolicyOnlyView) return `<span class="mono">${name}</span>: pressure metrics not collected for this source`;
      return `<span class="mono">${name}</span>: Q=${typeof q === 'number' ? Math.round(q * 100) + '%' : '—'} KV=${typeof k === 'number' ? Math.round(k * 100) + '%' : '—'} [${pl.toUpperCase()}]`;
    }).join('<br>');

    const scoreLines = providers
      .filter(p => typeof p.score === 'number')
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .map(p => {
        const name = p.cluster || p.name;
        const r = typeof p.rank === 'number' ? (p.rank === -1 ? 'X' : '#' + (p.rank + 1)) : '?';
        return `<span class="mono">${name}</span>: ${formatScore(p.score)} (${r})`;
      }).join('<br>');

    const routeLabel = latestTrace?.selected_cluster || selectedName;
    const routeDecision = isPolicyOnlyView
      ? 'Latest observed route; not a pressure-driven failover'
      : latestTrace?.routing_decision || (hasRouteChange ? routeEvent?.label : `${routeLabel} preferred`);

    const attrDetail = attrEvent?.detail
      || (latestTrace ? `gateway → ${routeLabel}` : '—');
    const attrValue = isPolicyOnlyView ? 'Observed trace counts' : attrDetail.split(',')[0];

    let narrativeParts = [];
    if (isPolicyOnlyView) {
      narrativeParts.push('<strong>Requests are being distributed across eligible active paths.</strong>');
      narrativeParts.push('This source has no pressure metrics, so an observed path change does not mean pressure-triggered failover.');
    } else if (hasRouteChange && routeEvent) {
      narrativeParts.push(`<strong>Route changed</strong>: ${routeEvent.label}.`);
      if (pLevel === 'critical' || pLevel === 'high') {
        narrativeParts.push(`Pressure on ${selectedName} is <strong>${pLevel.toUpperCase()}</strong>.`);
      }
    } else {
      narrativeParts.push(`<strong>${routeLabel}</strong> is the preferred provider (rank #1).`);
    }
    narrativeParts.push(`Scoring strategy: <strong>${strategyLabel}</strong>.`);
    if (strategy === 'noMetrics') {
      narrativeParts.push('All scores are 0.0 — routing by locality tier only.');
    }

    container.innerHTML = `
      <div class="causal-steps">
        <div class="causal-step ${trafficClass}">
          <div class="causal-step-header">Traffic</div>
          <div class="causal-step-value">${trafficDetail}</div>
          <div class="causal-step-detail">${providers.length} provider${providers.length !== 1 ? 's' : ''} in pool</div>
        </div>
        <div class="causal-connector">→</div>
        <div class="causal-step ${stepClass}">
          <div class="causal-step-header">Metrics</div>
          <div class="causal-step-value">${isPolicyOnlyView ? 'Not collected' : pressureLabel(pLevel)}</div>
          <div class="causal-step-detail">${metricLines}</div>
        </div>
        <div class="causal-connector">→</div>
        <div class="causal-step step-active">
          <div class="causal-step-header">${isPolicyOnlyView ? 'Selection policy' : `Score (${strategyLabel})`}</div>
          <div class="causal-step-value">${isPolicyOnlyView ? 'Policy-based' : scoreLines || '—'}</div>
          <div class="causal-step-detail">${isPolicyOnlyView ? 'Admission and locality/selection policy; no pressure score' : `Weights: locality=${SCORING_WEIGHTS_DISPLAY.locality}, queue=${SCORING_WEIGHTS_DISPLAY.queue_depth}`}</div>
        </div>
        <div class="causal-connector">→</div>
        <div class="causal-step step-active">
          <div class="causal-step-header">Route</div>
          <div class="causal-step-value">${routeLabel}</div>
          <div class="causal-step-detail">${routeDecision}</div>
        </div>
        <div class="causal-connector">→</div>
        <div class="causal-step step-ok">
          <div class="causal-step-header">Attribution</div>
          <div class="causal-step-value">${attrValue}</div>
          <div class="causal-step-detail">${attrDetail.includes(',') ? attrDetail : 'Confirmed by gateway'}</div>
        </div>
      </div>
      <div class="causal-summary">${narrativeParts.join(' ')}</div>
    `;
  }

  const SCORING_WEIGHTS_DISPLAY = { locality: 3.0, queue_depth: 5.0 };

  // -----------------------------------------------------------------------
  // Causal timeline
  // -----------------------------------------------------------------------

  async function fetchTimeline() {
    return apiFetch('/timeline');
  }

  function renderTimeline(events) {
    const container = document.getElementById('timeline');
    if (!container) return;
    if (!events || events.length === 0) {
      container.innerHTML = '<div class="empty-state">No events yet</div>';
      return;
    }

    container.innerHTML = events.map(e => {
      const severityClass = `timeline-${e.severity || 'info'}`;
      const iconMap = {
        baseline: '○',
        load_started: '▶',
        load_stopped: '■',
        threshold_crossed: '⚠',
        route_change: '⇄',
        attribution: '∑',
        rank_changed: '↕',
      };
      const icon = iconMap[e.type] || '●';
      return `
        <div class="timeline-event ${severityClass}">
          <span class="timeline-time">${e.time}</span>
          <span class="timeline-icon">${icon}</span>
          <div class="timeline-body">
            <span class="timeline-label">${e.label}</span>
            ${e.detail ? `<span class="timeline-detail">${e.detail}</span>` : ''}
            ${e.type === 'route_change' ? `<span class="timeline-cause">${e.detail?.includes('no pressure signal') ? 'Observed routing change; pressure causality is not available in this source.' : 'Observed routing change with supporting routing evidence.'}</span>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  // -----------------------------------------------------------------------
  // Routing state
  // -----------------------------------------------------------------------

  function renderRoutingState(trace, pools, scoringStrategy, overlayRevision) {
    const selected = pools?.find(p => p.rank === 0) || pools?.[0];
    const selectedName = selected?.cluster || selected?.name;
    const setText = (id, value) => {
      const element = document.getElementById(id);
      if (element) element.textContent = value;
    };
    setText('routing-policy', trace?.routing_policy || (selected ? 'scoreFirst' : '—'));
    setText('routing-selected', trace?.selected_cluster || trace?.selected_provider || selectedName || '—');
    setText('routing-decision', trace?.routing_decision || (selected ? `Live EPP rank #1 · ${scoringStrategy || 'unknown'}` : '—'));
    setText('routing-score', typeof trace?.provider_score === 'number'
      ? trace.provider_score.toFixed(2) : typeof selected?.score === 'number' ? selected.score.toFixed(2) : '—');
    setText('routing-revision', trace?.overlay_revision || overlayRevision || '—');
    setText('routing-admission', trace?.admission_state || selected?.admission_state || '—');
  }

  // -----------------------------------------------------------------------
  // Score bars
  // -----------------------------------------------------------------------

  function renderScoreBars(pools) {
    const container = document.getElementById('score-bars');
    if (!container) return;
    const scores = pools.map(p => typeof p.score === 'number' ? p.score : 0);
    if (!pools.some(p => typeof p.score === 'number')) {
      container.innerHTML = '<div class="score-unavailable"><strong>Score components unavailable</strong><span>This source exposes provider identity and routing state, but not the component contributions used to calculate its score. No bar is shown.</span></div>';
      return;
    }
    const maxScore = Math.max(...scores, 1);

    container.innerHTML = pools.map(pool => {
      const s = typeof pool.score === 'number' ? pool.score : null;
      const pct = s !== null ? (s / maxScore * 100).toFixed(1) : '0';
      const displayName = pool.cluster || pool.name;
      return `
        <div class="score-bar-row">
          <span class="score-bar-label">${displayName}</span>
          <div class="score-bar-track">
            <div class="score-bar-fill" data-pool="${displayName}" style="width: ${pct}%"></div>
          </div>
          <span class="score-bar-value">${formatScore(s)}</span>
        </div>
      `;
    }).join('');
  }

  // -----------------------------------------------------------------------
  // Refresh loop
  // -----------------------------------------------------------------------

  async function refreshAll() {
    try {
      const targetPool = document.getElementById('load-pool')?.value || 'pool-a';
      const fetches = [
        fetchStatus(),
        fetchPools(),
        apiFetch('/providers').catch(() => null),
        fetchTimeline().catch(() => null),
        fetchGeneratorStatus().catch(() => null),
        fetchLoadStatus().catch(() => null),
        fetchAttribution().catch(() => null),
      ];

      if (currentDataSource === 'vcr' || currentDataSource === 'combined') {
        fetches.push(apiFetch('/vcr/providers?target_pool=pool-a').catch(() => null));
        fetches.push(apiFetch(`/vcr/timeline?target_pool=${encodeURIComponent(targetPool)}`).catch(() => null));
        fetches.push(apiFetch('/vcr/providers?target_pool=pool-b').catch(() => null));
      }

      const results = await Promise.all(fetches);
      const [status, poolData, providerData, timelineData, generatorData, loadData, attributionData] = results;
      const vcrProviders = results[7] || null;
      const vcrTimeline = results[8] || null;
      const vcrProvidersB = results[9] || null;

      const activeVcrProviders = targetPool === 'pool-b' ? vcrProvidersB : vcrProviders;
      if (currentDataSource === 'vcr' && activeVcrProviders?.providers?.length) {
        lastPoolData = activeVcrProviders;
      } else if (providerData) {
        lastPoolData = providerData;
      }

      currentMode = status.configured_mode;
      if (status.data_source) currentDataSource = status.data_source;
      updateModeButtons();
      updateSourceButtons();
      updateModeBadge(status);
      updateGenerator(generatorData, attributionData);
      updateLoad(loadData);
      fetchCapabilities().then(renderCapabilities).catch(() => null);
      fetchRequests().catch(() => null);

      const isDemo = status.mode === 'demo';
      toggleScenarioBar(isDemo);
      if (isDemo && status.scenario) {
        updateActiveScenario(status.scenario);
      }

      const useVcrPools = currentDataSource === 'vcr' && activeVcrProviders?.providers?.length;
      const displayPools = useVcrPools
        ? activeVcrProviders.providers.map(p => ({
            ...p,
            queue_depth: p.queue_depth?.value ?? p.queue_depth,
            queue_depth_raw: p.queue_depth?.raw_value ?? null,
            kv_cache: p.kv_cache?.value ?? p.kv_cache,
          }))
        : poolData.pools;
      const displayTrace = currentDataSource === 'vcr' ? null : poolData.latest_trace;

      if (displayPools) {
        renderPoolCards(displayPools, displayTrace);
        renderScoreBars(displayPools);
      }
      renderLoadEppDetails([
        { label: 'Pool A', providers: vcrProviders?.providers || [] },
        { label: 'Pool B', providers: vcrProvidersB?.providers || [] },
      ]);

      if (displayTrace || useVcrPools) {
        renderRoutingState(displayTrace, displayPools, activeVcrProviders?.scoring_strategy || poolData?.scoring_strategy, activeVcrProviders?.overlay_revision);
      }

      const refreshState = document.getElementById('provider-refresh-state');
      if (refreshState) {
        refreshState.textContent = currentDataSource === 'vcr' && vcrProviders?.mode === 'live'
          ? `Updated ${new Date(vcrProviders.generated_at).toLocaleTimeString()}`
          : 'Values refresh every 3s';
        refreshState.className = `refresh-state ${currentDataSource === 'vcr' && vcrProviders?.mode === 'live' ? 'live' : ''}`;
      }

      const displayTimeline = currentDataSource === 'vcr' && vcrTimeline?.events?.length
        ? vcrTimeline.events
        : timelineData?.events;
      if (displayTimeline) {
        renderTimeline(displayTimeline);
      }

      const causalProviders = (lastPoolData?.providers || lastPoolData?.pools || []).map(p => ({
        ...p,
        queue_depth: typeof p.queue_depth === 'object' ? p.queue_depth?.value : p.queue_depth,
        kv_cache: typeof p.kv_cache === 'object' ? p.kv_cache?.value : p.kv_cache,
      }));
      const causalStrategy = lastPoolData?.scoring_strategy || 'unknown';
      renderCausalChain(causalProviders, displayTrace, displayTimeline, causalStrategy);

      const jaegerEl = document.getElementById('footer-jaeger');
      jaegerEl.textContent = status.jaeger_reachable
        ? `Jaeger: ${status.jaeger_url}`
        : 'Jaeger: unreachable';
    } catch (err) {
      console.error('Refresh failed:', err);
    }
  }

  // -----------------------------------------------------------------------
  // Init
  // -----------------------------------------------------------------------

  async function init() {
    await initScenarioBar();
    const explorer = document.getElementById('request-explorer');
    const generator = document.getElementById('request-generator');
    const historyExplainer = document.getElementById('request-history-explainer');
    if (explorer && generator && historyExplainer) explorer.insertBefore(generator, historyExplainer);
    document.getElementById('request-refresh')?.addEventListener('click', () => fetchRequests().catch(() => null));
    document.getElementById('request-older')?.addEventListener('click', () => fetchRequests({ append: true }).catch(() => null));
    document.getElementById('request-search')?.addEventListener('input', () => renderRequestExplorer());
    document.getElementById('request-window')?.addEventListener('change', () => fetchRequests().catch(() => null));
    document.getElementById('request-provider')?.addEventListener('change', () => fetchRequests().catch(() => null));
    document.getElementById('history-scrubber')?.addEventListener('input', () => renderRequestExplorer());
    document.getElementById('replay-back')?.addEventListener('click', () => { stopReplay(); setReplayPosition(Number(document.getElementById('history-scrubber')?.value || 100) - 10); });
    document.getElementById('replay-forward')?.addEventListener('click', () => { stopReplay(); setReplayPosition(Number(document.getElementById('history-scrubber')?.value || 0) + 10); });
    document.getElementById('replay-play')?.addEventListener('click', toggleReplay);
    document.getElementById('request-detail-close')?.addEventListener('click', () => document.getElementById('request-detail')?.classList.add('hidden'));
    document.querySelectorAll('.token-state-btn').forEach(button => button.addEventListener('click', () => {
      tokenRateLimitState = button.dataset.tokenState || 'recovered';
      document.querySelectorAll('.token-state-btn').forEach(item => item.classList.toggle('active', item === button));
      if (tokenRateLimitEnabled) fetchTokenRateLimit().then(renderTokenRateLimitResponse).catch(error => renderTokenRateLimitResponse({ warning: error.message }));
    }));
    document.getElementById('token-request-a')?.addEventListener('click', () => sendTokenRateLimitRequest('a'));
    document.getElementById('token-request-b')?.addEventListener('click', () => sendTokenRateLimitRequest('b'));
    document.getElementById('token-clear-results')?.addEventListener('click', () => clearTokenRateLimitResults().catch(error => {
      const status = document.getElementById('token-request-status');
      if (status) status.textContent = error.message;
    }));
    connectRequestEvents();
    await refreshAll();
    refreshTimer = setInterval(refreshAll, REFRESH_INTERVAL);
  }

  init();
})();
