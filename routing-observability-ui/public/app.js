(function () {
  'use strict';

  const REFRESH_INTERVAL = 3000;
  let currentMode = 'auto';
  let effectiveMode = 'unknown';
  let refreshTimer = null;
  let sourceFilter = 'all';
  let lastTraces = [];
  let currentDataSource = 'glb';
  let previousPoolSnapshot = new Map();

  // -----------------------------------------------------------------------
  // API
  // -----------------------------------------------------------------------

  async function apiFetch(path, opts) {
    const res = await fetch(`/api${path}`, opts);
    if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
    return res.json();
  }

  async function fetchStatus() {
    return apiFetch('/status');
  }

  async function fetchPools() {
    return apiFetch('/pools');
  }

  async function fetchTraces(limit) {
    return apiFetch(`/traces?limit=${limit || 20}`);
  }

  async function fetchTraceDetail(traceId) {
    return apiFetch(`/trace/${traceId}`);
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

  async function fetchAttribution() {
    return apiFetch('/attribution');
  }

  window.startRequestGeneration = async function () {
    const payload = {
      count: Number(document.getElementById('generator-count').value),
      rate: Number(document.getElementById('generator-rate').value),
      prompt: document.getElementById('generator-prompt').value,
    };
    try {
      await apiFetch('/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      await refreshAll();
    } catch (error) {
      updateGenerator({ error: error.message });
    }
  };

  window.cancelRequestGeneration = async function () {
    await apiFetch('/generate/cancel', { method: 'POST' }).catch(() => {});
    await refreshAll();
  };

  function updateGenerator(status, attribution) {
    const section = document.getElementById('request-generator');
    const start = document.getElementById('generator-start');
    const cancel = document.getElementById('generator-cancel');
    const badge = document.getElementById('generator-status');
    const progress = document.getElementById('generator-progress');
    if (!section || !start || !cancel || !badge || !progress) return;
    const available = status?.available !== false && currentDataSource === 'glb' && effectiveMode !== 'demo';
    section.classList.toggle('hidden', !available);
    const job = status?.job;
    const running = !!job?.running;
    start.disabled = running;
    cancel.classList.toggle('hidden', !running);
    badge.textContent = running ? 'Running' : job?.error ? 'Error' : job ? 'Complete' : 'Ready';
    badge.className = `generator-status ${running ? 'running' : job?.error ? 'error' : ''}`;
    if (job) {
      progress.innerHTML = job.error
        ? `<span class="generator-error">${escapeHtml(job.error)}</span>`
        : `<div class="generator-progress-grid">
            <div><strong>${job.completed}/${job.count}</strong><span>complete</span></div>
            <div class="success"><strong>${job.succeeded}</strong><span>succeeded</span></div>
            <div class="failed"><strong>${job.failed}</strong><span>failed</span></div>
            <div><strong>${running ? '…' : 'Done'}</strong><span>${running ? 'sending' : 'job status'}</span></div>
          </div>`;
    } else {
      progress.textContent = 'No requests generated yet.';
    }
    const attributionEl = document.getElementById('generator-attribution');
    if (attributionEl) {
      if (!attribution?.available || !attribution.sample_size) {
        attributionEl.textContent = 'Observed trace attribution will appear here.';
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
        attributionEl.innerHTML = `<div class="attribution-heading"><strong>Observed route attribution</strong><span>${attribution.sample_size} current traced requests${runLabel}</span></div><div class="attribution-grid">${entries || '<span>No provider selected</span>'}</div>`;
      }
    }
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
    document.querySelectorAll('.source-btn').forEach(btn => {
      btn.classList.toggle('active', btn.id === `btn-src-${currentDataSource}`);
    });
    const badge = document.getElementById('source-badge');
    if (badge) {
      badge.className = 'badge';
      if (currentDataSource === 'vcr') {
        badge.textContent = 'VCR/EPP';
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
    const badge = document.getElementById('mode-badge');
    effectiveMode = status.mode;

    badge.className = 'badge';
    if (currentDataSource === 'vcr') {
      badge.textContent = status.vcr_mode === 'live' ? 'LIVE EPP' : status.vcr_mode === 'evidence' ? 'EVIDENCE' : 'UNAVAILABLE';
      badge.classList.add(status.vcr_mode === 'live' ? 'badge-live' : 'badge-unknown');
      return;
    }
    switch (status.mode) {
      case 'live':
        if (status.live_detail === 'praxis') {
          badge.textContent = 'LIVE PRAXIS';
          badge.classList.add('badge-live-praxis');
        } else if (status.live_detail === 'synthetic') {
          badge.textContent = 'LIVE SYNTHETIC';
          badge.classList.add('badge-live-synthetic');
        } else {
          badge.textContent = 'LIVE';
          badge.classList.add('badge-live');
        }
        break;
      case 'demo':
        badge.textContent = 'MOCK DATA';
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
  // Source filter
  // -----------------------------------------------------------------------

  window.setSourceFilter = function (filter) {
    sourceFilter = filter;
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === filter);
    });
    renderTraces(lastTraces);
  };

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
              <span class="metric-label">Queue</span>
              <span class="metric-value">${formatMetric(pool.queue_depth, 'ratio')} ${queueChange.delta}</span>
            </div>
            <div class="metric">
              <span class="metric-label">KV Cache</span>
              <span class="metric-value">${formatMetric(pool.kv_cache, 'ratio')}</span>
            </div>
            <div class="metric">
              <span class="metric-label">Tier</span>
              <span class="metric-value">${tierLabel}</span>
            </div>
          </div>
          <div class="pool-score-section">
            <div class="score-block ${scoreChange.className}">
              <span class="pool-score-label">Score</span>
              <div class="pool-score-value">${formatScore(pool.score)} ${scoreChange.delta}</div>
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
    document.getElementById('routing-policy').textContent = trace?.routing_policy || (selected ? 'scoreFirst' : '—');
    document.getElementById('routing-selected').textContent = trace?.selected_cluster || trace?.selected_provider || selectedName || '—';
    document.getElementById('routing-decision').textContent = trace?.routing_decision || (selected ? `Live EPP rank #1 · ${scoringStrategy || 'unknown'}` : '—');
    document.getElementById('routing-score').textContent = typeof trace?.provider_score === 'number'
      ? trace.provider_score.toFixed(2) : typeof selected?.score === 'number' ? selected.score.toFixed(2) : '—';
    document.getElementById('routing-revision').textContent = trace?.overlay_revision || overlayRevision || '—';
    document.getElementById('routing-admission').textContent = trace?.admission_state || selected?.admission_state || '—';
  }

  // -----------------------------------------------------------------------
  // Score bars
  // -----------------------------------------------------------------------

  function renderScoreBars(pools) {
    const container = document.getElementById('score-bars');
    const scores = pools.map(p => typeof p.score === 'number' ? p.score : 0);
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
  // Traces table
  // -----------------------------------------------------------------------

  function renderTraces(traces) {
    lastTraces = traces || [];
    const tbody = document.getElementById('traces-body');
    let filtered = lastTraces;
    if (sourceFilter !== 'all') {
      filtered = filtered.filter(t => t.source === sourceFilter);
    }

    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No traces yet</td></tr>';
      return;
    }

    tbody.innerHTML = filtered.slice(0, 20).map(t => {
      const shortId = t.trace_id.length > 16 ? t.trace_id.substring(0, 8) + '...' + t.trace_id.substring(t.trace_id.length - 8) : t.trace_id;
      const provider = t.selected_provider || 'unknown';
      const cluster = t.selected_cluster || '';
      const clusterName = cluster || provider;
      const score = typeof t.provider_score === 'number' ? t.provider_score.toFixed(2) : '—';
      const duration = t.duration_us ? (t.duration_us / 1000).toFixed(1) + 'ms' : '—';
      const time = t.timestamp ? new Date(t.timestamp).toLocaleTimeString() : '—';
      const source = t.source || t.scenario || '—';
      const sourceClass = source === 'praxis' ? 'source-praxis' : source === 'synthetic' ? 'source-synthetic' : '';
      const propIcon = t.has_traceparent ? 'propagated' : '—';
      const propClass = t.has_traceparent ? 'prop-yes' : 'prop-no';

      return `
        <tr class="trace-row" data-trace-id="${t.trace_id}" onclick="showTraceDetail('${t.trace_id}')">
          <td><a href="${t.jaeger_url}" target="_blank" rel="noopener" class="trace-id-link" title="${t.trace_id}" onclick="event.stopPropagation()">${shortId}</a></td>
          <td><span class="provider-chip">${clusterName}</span></td>
          <td>${score}</td>
          <td>${duration}</td>
          <td>${t.span_count || '—'}${t.service_count > 1 ? ` <span class="svc-count">(${t.service_count} svc)</span>` : ''}</td>
          <td><span class="${sourceClass}">${source}</span></td>
          <td><span class="${propClass}">${propIcon}</span></td>
          <td>${time}</td>
        </tr>
      `;
    }).join('');
  }

  // -----------------------------------------------------------------------
  // Trace detail panel
  // -----------------------------------------------------------------------

  window.showTraceDetail = async function (traceId) {
    const panel = document.getElementById('trace-detail');
    const content = document.getElementById('trace-detail-content');
    panel.classList.remove('hidden');

    content.innerHTML = '<div class="empty-state">Loading trace...</div>';

    try {
      const trace = await fetchTraceDetail(traceId);
      renderTraceDetail(trace, content);
    } catch {
      content.innerHTML = '<div class="empty-state">Failed to load trace detail</div>';
    }
  };

  window.closeTraceDetail = function () {
    document.getElementById('trace-detail').classList.add('hidden');
  };

  function renderTraceDetail(trace, container) {
    const spans = trace.spans || [];
    const spanMap = {};
    spans.forEach(s => { spanMap[s.span_id] = s; });

    const rootSpans = spans.filter(s => !s.parent_span_id || !spanMap[s.parent_span_id]);

    function buildTree(span, depth) {
      const children = spans.filter(s => s.parent_span_id === span.span_id);
      const indent = depth * 20;
      const kindClass = `kind-${span.kind.toLowerCase()}`;
      const durMs = span.duration_us ? (span.duration_us / 1000).toFixed(1) : '—';
      const tagEntries = Object.entries(span.tags || {});
      const routingTags = tagEntries.filter(([k]) =>
        k.startsWith('selected.') || k.startsWith('routing.') || k.startsWith('overlay.')
        || k === 'http.request.method' || k === 'http.route');

      let html = `
        <div class="span-row" style="padding-left: ${indent}px">
          <div class="span-header">
            <span class="span-connector">${depth > 0 ? '|__ ' : ''}</span>
            <span class="span-name">${span.operation}</span>
            <span class="span-kind ${kindClass}">${span.kind}</span>
            <span class="span-duration">${durMs}ms</span>
            <span class="span-id">${span.span_id.substring(0, 8)}</span>
          </div>`;

      if (routingTags.length > 0) {
        html += '<div class="span-tags">';
        routingTags.forEach(([k, v]) => {
          html += `<span class="span-tag"><span class="tag-key">${k}</span>=<span class="tag-val">${v}</span></span>`;
        });
        html += '</div>';
      }

      html += '</div>';

      children.forEach(child => {
        html += buildTree(child, depth + 1);
      });

      return html;
    }

    const sourceLabel = trace.source === 'praxis' ? 'Praxis AI (real)' :
      trace.source === 'synthetic' ? 'Grid POC (synthetic)' : trace.source;
    const sourceClass = trace.source === 'praxis' ? 'source-praxis' : trace.source === 'synthetic' ? 'source-synthetic' : '';
    const propStatus = trace.has_traceparent ? 'Propagated' : 'Not propagated';
    const propClass = trace.has_traceparent ? 'prop-yes' : 'prop-no';

    let html = `
      <div class="detail-meta">
        <div class="meta-row">
          <span class="meta-key">Trace ID</span>
          <span class="meta-value mono">${trace.trace_id}</span>
        </div>
        <div class="meta-row">
          <span class="meta-key">Source</span>
          <span class="meta-value ${sourceClass}">${sourceLabel}</span>
        </div>
        <div class="meta-row">
          <span class="meta-key">Spans</span>
          <span class="meta-value">${trace.span_count}</span>
        </div>
        <div class="meta-row">
          <span class="meta-key">Provider Propagation</span>
          <span class="meta-value ${propClass}">${propStatus}</span>
        </div>
        ${trace.service_count > 1 ? `<div class="meta-row">
          <span class="meta-key">Services (${trace.service_count})</span>
          <span class="meta-value">${(trace.services || []).join(' → ')}</span>
        </div>` : ''}
        <div class="meta-row">
          <span class="meta-key">Provider</span>
          <span class="meta-value">${trace.selected_provider}</span>
        </div>
        <div class="meta-row">
          <span class="meta-key">Cluster</span>
          <span class="meta-value">${trace.selected_cluster}</span>
        </div>
      </div>
      <div class="detail-spans-header">Span Hierarchy</div>
      <div class="detail-spans">`;

    rootSpans.forEach(root => {
      html += buildTree(root, 0);
    });

    html += '</div>';
    container.innerHTML = html;
  }

  // -----------------------------------------------------------------------
  // Refresh loop
  // -----------------------------------------------------------------------

  async function refreshAll() {
    try {
      const fetches = [
        fetchStatus(),
        fetchPools(),
        fetchTraces(20),
        apiFetch('/providers').catch(() => null),
        fetchTimeline().catch(() => null),
        fetchGeneratorStatus().catch(() => null),
        fetchAttribution().catch(() => null),
      ];

      if (currentDataSource === 'vcr' || currentDataSource === 'combined') {
        fetches.push(apiFetch('/vcr/providers').catch(() => null));
        fetches.push(apiFetch('/vcr/timeline').catch(() => null));
      }

      const results = await Promise.all(fetches);
      const [status, poolData, traceData, providerData, timelineData, generatorData, attributionData] = results;
      const vcrProviders = results[7] || null;
      const vcrTimeline = results[8] || null;

      if (currentDataSource === 'vcr' && vcrProviders?.providers?.length) {
        lastPoolData = vcrProviders;
      } else if (providerData) {
        lastPoolData = providerData;
      }

      currentMode = status.configured_mode;
      if (status.data_source) currentDataSource = status.data_source;
      updateModeButtons();
      updateSourceButtons();
      updateModeBadge(status);
      updateGenerator(generatorData, attributionData);

      const isDemo = status.mode === 'demo';
      toggleScenarioBar(isDemo && currentDataSource === 'glb');
      if (isDemo && status.scenario) {
        updateActiveScenario(status.scenario);
      }

      const useVcrPools = currentDataSource === 'vcr' && vcrProviders?.providers?.length;
      const displayPools = useVcrPools
        ? vcrProviders.providers.map(p => ({
            ...p,
            queue_depth: p.queue_depth?.value ?? p.queue_depth,
            queue_depth_raw: p.queue_depth?.raw_value ?? null,
            kv_cache: p.kv_cache?.value ?? p.kv_cache,
          }))
        : poolData.pools;
      const displayTrace = currentDataSource === 'vcr' ? null : poolData.latest_trace;

      if (displayPools) {
        renderTopology(displayPools, displayTrace);
        renderPoolCards(displayPools, displayTrace);
        renderScoreBars(displayPools);
      }

      if (displayTrace || useVcrPools) {
        renderRoutingState(displayTrace, displayPools, vcrProviders?.scoring_strategy || poolData?.scoring_strategy, vcrProviders?.overlay_revision);
      }

      const refreshState = document.getElementById('provider-refresh-state');
      if (refreshState) {
        refreshState.textContent = currentDataSource === 'vcr' && vcrProviders?.mode === 'live'
          ? `Updated ${new Date(vcrProviders.generated_at).toLocaleTimeString()}`
          : 'Values refresh every 3s';
        refreshState.className = `refresh-state ${currentDataSource === 'vcr' && vcrProviders?.mode === 'live' ? 'live' : ''}`;
      }

      if (traceData.traces && currentDataSource !== 'vcr') {
        renderTraces(traceData.traces);
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
    await refreshAll();
    refreshTimer = setInterval(refreshAll, REFRESH_INTERVAL);
  }

  init();
})();
