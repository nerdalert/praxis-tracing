import express from 'express';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import http from 'http';
import https from 'https';
import { execFile } from 'child_process';
import { promisify } from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// Optional demo protection. Authentication is disabled unless both variables
// are configured. The password is never included in responses or logs.
const UI_AUTH_USERNAME = process.env.TRACING_UI_AUTH_USERNAME || null;
const UI_AUTH_PASSWORD = process.env.TRACING_UI_AUTH_PASSWORD || null;
const UI_LOGIN_PAGE = process.env.TRACING_UI_LOGIN_PAGE === 'true';
const UI_SESSION_COOKIE = 'praxis_ui_session';
const UI_SESSION_TTL_SECONDS = 3600;
if ((UI_AUTH_USERNAME && !UI_AUTH_PASSWORD) || (!UI_AUTH_USERNAME && UI_AUTH_PASSWORD)) {
  throw new Error('TRACING_UI_AUTH_USERNAME and TRACING_UI_AUTH_PASSWORD must be configured together');
}

function basicAuthValid(header) {
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return false;
  const username = Buffer.from(decoded.slice(0, separator));
  const password = Buffer.from(decoded.slice(separator + 1));
  const expectedUsername = Buffer.from(UI_AUTH_USERNAME);
  const expectedPassword = Buffer.from(UI_AUTH_PASSWORD);
  return username.length === expectedUsername.length
    && password.length === expectedPassword.length
    && timingSafeEqual(username, expectedUsername)
    && timingSafeEqual(password, expectedPassword);
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return [part.trim(), ''];
    return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }).filter(([key]) => key));
}

function sessionToken(username, expires) {
  const payload = `${username}.${expires}`;
  const signature = createHmac('sha256', UI_AUTH_PASSWORD).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${signature}`;
}

function sessionValid(header) {
  if (!UI_LOGIN_PAGE || !UI_AUTH_USERNAME || !UI_AUTH_PASSWORD) return false;
  const token = parseCookies(header)[UI_SESSION_COOKIE];
  if (!token) return false;
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return false;
  let payload;
  try { payload = Buffer.from(encoded, 'base64url').toString('utf8'); } catch { return false; }
  const [username, expiresText] = payload.split('.');
  const expires = Number(expiresText);
  const expected = sessionToken(username, expires).split('.')[1];
  return username === UI_AUTH_USERNAME && Number.isSafeInteger(expires)
    && expires > Math.floor(Date.now() / 1000)
    && signature.length === expected.length
    && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

const LOGIN_PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Praxis Tracing Login</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f5f5;color:#171717;font:15px system-ui,sans-serif}.card{width:min(360px,calc(100% - 40px));padding:28px;background:#fff;border:1px solid #d7d7d7;border-top:3px solid #e11;box-shadow:0 8px 24px #0001}h1{margin:0 0 8px;font-size:24px}p{color:#666;line-height:1.45}label{display:grid;gap:6px;margin:14px 0;font-weight:600}input{box-sizing:border-box;padding:10px;border:1px solid #aaa;font:inherit}button{width:100%;margin-top:8px;padding:11px;border:0;background:#e11;color:#fff;font-weight:700;cursor:pointer}#error{min-height:20px;color:#b00020}</style></head><body><main class="card"><h1>Praxis Tracing</h1><p>Sign in to view the live quota demonstration.</p><form id="login"><label>Username<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><div id="error"></div><button>Sign in</button></form></main><script>document.querySelector('#login').addEventListener('submit',async(e)=>{e.preventDefault();const f=new FormData(e.currentTarget);const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:f.get('username'),password:f.get('password')})});if(r.ok)location.href='/';else document.querySelector('#error').textContent='Invalid username or password.'})</script></body></html>`;

if (UI_AUTH_USERNAME && UI_AUTH_PASSWORD) {
  app.use((req, res, next) => {
    if (basicAuthValid(req.headers.authorization) || sessionValid(req.headers.cookie)) return next();
    if (UI_LOGIN_PAGE && req.path === '/login') return next();
    if (UI_LOGIN_PAGE && (req.path === '/api/login' || req.path === '/api/logout')) return next();
    if (UI_LOGIN_PAGE && !req.path.startsWith('/api/')) return res.redirect('/login');
    res.set('WWW-Authenticate', 'Basic realm="Praxis Tracing"');
    return res.status(401).send('Authentication required');
  });
}

app.use(express.json());
if (UI_LOGIN_PAGE) {
  app.get('/login', (_req, res) => res.type('html').send(LOGIN_PAGE_HTML));
  app.post('/api/login', (req, res) => {
    if (req.body?.username !== UI_AUTH_USERNAME || req.body?.password !== UI_AUTH_PASSWORD) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const expires = Math.floor(Date.now() / 1000) + UI_SESSION_TTL_SECONDS;
    res.set('Set-Cookie', `${UI_SESSION_COOKIE}=${encodeURIComponent(sessionToken(UI_AUTH_USERNAME, expires))}; Path=/; Max-Age=${UI_SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`);
    return res.json({ authenticated: true });
  });
  app.post('/api/logout', (_req, res) => {
    res.set('Set-Cookie', `${UI_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    return res.json({ authenticated: false });
  });
}
// Prefer the compiled React application when present. The legacy public
// frontend remains as a safe development fallback until the first build.
const distRoot = join(__dirname, 'dist');
app.use(express.static(existsSync(join(distRoot, 'index.html')) ? distRoot : join(__dirname, 'public')));

function strictBoolean(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be exactly true or false`);
}

const TOKEN_RATE_LIMIT_ENABLED = strictBoolean('TRACING_UI_TOKEN_RATE_LIMIT');
const TOKEN_RATE_LIMIT_FIXTURE_MODE = process.env.TRACING_UI_FIXTURE_MODE || null;
if (TOKEN_RATE_LIMIT_FIXTURE_MODE && TOKEN_RATE_LIMIT_FIXTURE_MODE !== 'token-rate-limit') {
  throw new Error('TRACING_UI_FIXTURE_MODE must be token-rate-limit when set');
}
const TOKEN_RATE_LIMIT_FIXTURES = TOKEN_RATE_LIMIT_ENABLED && TOKEN_RATE_LIMIT_FIXTURE_MODE === 'token-rate-limit';
const TOKEN_RATE_LIMIT_CONSUMERS = {
  a: process.env.TRACING_UI_TOKEN_CONSUMER_A_URL || null,
  b: process.env.TRACING_UI_TOKEN_CONSUMER_B_URL || null,
};
const TOKEN_RATE_LIMIT_CONSUMER_LABELS = {
  a: process.env.TRACING_UI_TOKEN_CONSUMER_A_LABEL || 'consumer-gateway-a',
  b: process.env.TRACING_UI_TOKEN_CONSUMER_B_LABEL || 'consumer-gateway-b',
};
const TOKEN_RATE_LIMIT_MODEL = process.env.TRACING_UI_TOKEN_MODEL || 'Qwen/Qwen3-0.6B';
const TOKEN_RATE_LIMIT_USERNAME = process.env.TRACING_UI_TOKEN_USERNAME || 'alice';
const TOKEN_RATE_LIMIT_CONFIGURED_LIMIT = Number.parseInt(process.env.TRACING_UI_TOKEN_LIMIT || '60', 10);
const TOKEN_RATE_LIMIT_WINDOW_SECONDS = Number.parseInt(process.env.TRACING_UI_TOKEN_WINDOW_SECONDS || '60', 10);
const TOKEN_RATE_LIMIT_MIN_TOKENS = Number.parseInt(process.env.TRACING_UI_TOKEN_MIN_TOKENS || '1', 10);
const TOKEN_RATE_LIMIT_MAX_TOKENS = Number.parseInt(process.env.TRACING_UI_TOKEN_MAX_TOKENS || '5', 10);
const TOKEN_RATE_LIMIT_BACKEND_LABEL = process.env.TRACING_UI_TOKEN_BACKEND_LABEL || 'vllm-vcr';
const TOKEN_RATE_LIMIT_PASSWORD_FILE = process.env.TRACING_UI_TOKEN_PASSWORD_FILE || null;
const TOKEN_RATE_LIMIT_PASSWORD = process.env.TRACING_UI_TOKEN_PASSWORD
  || (TOKEN_RATE_LIMIT_PASSWORD_FILE ? readFileSync(TOKEN_RATE_LIMIT_PASSWORD_FILE, 'utf8').trim() : null);
const TOKEN_RATE_LIMIT_MULTI_QUOTA = strictBoolean('TRACING_UI_TOKEN_MULTI_QUOTA');
// Feature gate: cloud-burst pressure/failover visualization. Additive and
// opt-in — when off, the quota demo behaves exactly as before.
const TOKEN_CLOUD_BURST = strictBoolean('TRACING_UI_TOKEN_CLOUD_BURST');
const TOKEN_RATE_LIMIT_APPS_FILE = process.env.TRACING_UI_TOKEN_APPS_FILE || null;
function loadTokenRateLimitApps() {
  if (!TOKEN_RATE_LIMIT_MULTI_QUOTA || !TOKEN_RATE_LIMIT_APPS_FILE) return [];
  if (!existsSync(TOKEN_RATE_LIMIT_APPS_FILE)) throw new Error('TRACING_UI_TOKEN_APPS_FILE does not exist');
  let parsed;
  try { parsed = JSON.parse(readFileSync(TOKEN_RATE_LIMIT_APPS_FILE, 'utf8')); } catch (error) {
    throw new Error(`TRACING_UI_TOKEN_APPS_FILE is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length < 2 || parsed.length > 3) throw new Error('TRACING_UI_TOKEN_APPS_FILE must contain two or three applications');
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || !/^[a-z][a-z0-9-]{0,31}$/.test(entry.id)
      || !/^[a-z][a-z0-9-]{0,31}$/.test(entry.username) || typeof entry.model !== 'string' || entry.model.length < 1 || entry.model.length > 128
      || !/^#[0-9a-f]{6}$/i.test(entry.color || '')) throw new Error(`Invalid application entry at index ${index}`);
    const password = entry.password || (entry.passwordFile && existsSync(entry.passwordFile) ? readFileSync(entry.passwordFile, 'utf8').trim() : null);
    const limit = Number.parseInt(entry.limit, 10);
    const windowSeconds = Number.parseInt(entry.windowSeconds, 10);
    const estimateTokens = Number.parseInt(entry.estimateTokens ?? '5', 10);
    const maxTokens = Number.parseInt(entry.maxTokens ?? '0', 10);
    if (!password || password.length > 256 || !Number.isInteger(limit) || limit <= 0 || !Number.isInteger(windowSeconds) || windowSeconds <= 0 || !Number.isInteger(estimateTokens) || estimateTokens <= 0 || estimateTokens > 256 || (maxTokens && (maxTokens < estimateTokens || maxTokens > 256))) throw new Error(`Application ${entry.id} has invalid quota credentials or bounds`);
    return { id: entry.id, name: String(entry.name || entry.id).slice(0, 64), username: entry.username, password, model: entry.model, color: entry.color, limit, windowSeconds, estimateTokens, ...(maxTokens ? { maxTokens } : {}) };
  });
}
const TOKEN_RATE_LIMIT_APPS = loadTokenRateLimitApps();
const TOKEN_RATE_LIMIT_HISTORY_LIMIT = 100;
const TOKEN_RATE_LIMIT_LIVE = TOKEN_RATE_LIMIT_ENABLED
  && !TOKEN_RATE_LIMIT_FIXTURES
  && Boolean(TOKEN_RATE_LIMIT_CONSUMERS.a && TOKEN_RATE_LIMIT_CONSUMERS.b
    && (TOKEN_RATE_LIMIT_MULTI_QUOTA ? TOKEN_RATE_LIMIT_APPS.length >= 2 : TOKEN_RATE_LIMIT_PASSWORD));

const PORT = parseInt(process.env.PORT || '3001', 10);
const JAEGER_URL = process.env.JAEGER_URL || 'http://localhost:16686';
// The server-side query endpoint and browser-visible Jaeger UI endpoint may
// differ when the dashboard is reached through a remote host or tunnel.
const JAEGER_UI_URL = process.env.JAEGER_UI_URL || JAEGER_URL;
const VCR_EVIDENCE_DIR = process.env.VCR_EVIDENCE_DIR || null;
const execFileAsync = promisify(execFile);
const GLB_KUBECTL_CONTEXT = process.env.GLB_KUBECTL_CONTEXT || 'kind-grid-glb-gtm-emulator';
const GLB_GTM_SERVICE = process.env.GLB_GTM_SERVICE || 'gtm-emulator';
const GLB_GTM_NAMESPACE = process.env.GLB_GTM_NAMESPACE || 'grid-system';
const GLB_MODEL = process.env.GLB_MODEL || 'Qwen/Qwen3-0.6B';
const VCR_LIVE_ENABLED = process.env.VCR_LIVE !== 'false';
const VCR_CONTEXTS = [
  process.env.VCR_KUBECTL_CONTEXT_A || 'kind-grid-llmd-pm-pool-a',
  process.env.VCR_KUBECTL_CONTEXT_B || 'kind-grid-llmd-pm-pool-b',
];
const VCR_NAMESPACE = process.env.VCR_NAMESPACE || 'grid-system';
const VCR_GATEWAY_SERVICE = process.env.VCR_GATEWAY_SERVICE || 'consumer-gateway';
const VCR_GATEWAY_PORT = Number.parseInt(process.env.VCR_GATEWAY_PORT || '8080', 10);
const VCR_MODEL = process.env.VCR_MODEL || 'Qwen/Qwen3-0.6B';
const VCR_QUEUE_CAPACITY = Number.parseFloat(process.env.VCR_QUEUE_CAPACITY || '4');
const VCR_OVERLAY_CONFIGMAP = process.env.VCR_OVERLAY_CONFIGMAP
  || 'grid-overlay-grid-llmd-pool-metrics-consumer-gateway';
// Synthetic values are opt-in. A normal deployment must never turn a missing
// telemetry source into a convincing-looking demo state.
const ALLOW_SIMULATION = process.env.ALLOW_SIMULATION === 'true';
let liveVcrCache = { expires: 0, key: null, value: null };
let glbReadiness = { expires: 0, available: false, reason: 'Not checked yet' };
let vcrReadiness = { expires: 0, available: false, reason: 'Not checked yet' };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let currentMode = 'auto'; // auto, live, demo
let demoScenario = 'baseline';
// Deployment profiles select the live source at startup.  The llm-d/token
// rate-limit deployment must not boot into the unrelated GLB view.
const configuredProfile = process.env.TRACING_UI_PROFILE || null;
const TOKEN_RATE_LIMIT_PROFILE = configuredProfile === 'token-rate-limit';
let dataSource = TOKEN_RATE_LIMIT_PROFILE || configuredProfile === 'llmd'
  ? 'vcr'
  : configuredProfile === 'combined'
    ? 'combined'
    : 'glb'; // glb, vcr, combined
let requestJob = null;
let loadJob = null;
const liveGeneratedHistory = [];
let demoRun = null;
const eventClients = new Set();
const replayJobs = new Map();
const tokenRateLimitHistory = [];
let tokenRateLimitSequence = 0;

// This is the stable adapter contract for the future live OTel/HTTP source.
// UI code consumes these normalized fields and does not depend on exporter-
// specific attribute names.
const TOKEN_RATE_LIMIT_CONTRACT = {
  version: 'token-rate-limit.v1',
  request: ['principal', 'model', 'consumer_gateway', 'admission', 'quota', 'route', 'http', 'trace'],
  quota: ['backend', 'limit', 'used', 'remaining', 'reset_at', 'retry_after_seconds'],
  route: ['provider_gateway', 'inference_provider', 'overlay_revision', 'hops'],
  trace: ['trace_id', 'jaeger_url', 'spans'],
};

function rateLimitHeader(headers, name) {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function parseOptionalInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function tokenRateLimitRequest(consumer, appConfig = null, sessionId = null) {
  return new Promise((resolve, reject) => {
    const target = new URL(TOKEN_RATE_LIMIT_CONSUMERS[consumer]);
    const client = target.protocol === 'https:' ? https : http;
    const maxTokens = Number.isInteger(appConfig?.maxTokens) ? appConfig.maxTokens : TOKEN_RATE_LIMIT_MAX_TOKENS;
    const minTokens = Math.min(TOKEN_RATE_LIMIT_MIN_TOKENS, maxTokens);
    const requestedTokens = minTokens + Math.floor(Math.random() * (maxTokens - minTokens + 1));
    const payload = JSON.stringify({
      model: appConfig?.model || TOKEN_RATE_LIMIT_MODEL,
      messages: [{ role: 'user', content: `token-rate-limit-live-${tokenRateLimitSequence + 1}` }],
      max_tokens: requestedTokens,
    });
    const request = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: new URL('/v1/chat/completions', target).pathname,
      method: 'POST',
      timeout: 30000,
      rejectUnauthorized: target.protocol !== 'https:' || process.env.TRACING_UI_TOKEN_TLS_INSECURE !== 'true',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Basic ${Buffer.from(`${appConfig?.username || TOKEN_RATE_LIMIT_USERNAME}:${appConfig?.password || TOKEN_RATE_LIMIT_PASSWORD}`).toString('base64')}`,
        'X-Model': appConfig?.model || TOKEN_RATE_LIMIT_MODEL,
        ...(sessionId ? { 'X-Session-Id': sessionId } : {}),
      },
    }, response => {
      let responseBody = '';
      response.on('data', chunk => { responseBody += chunk; });
      response.on('end', () => {
        let actualTokens = null;
        let inputTokens = null;
        let outputTokens = null;
        try {
          const usage = JSON.parse(responseBody)?.usage || {};
          actualTokens = usage.total_tokens ?? null;
          inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? null;
          outputTokens = usage.completion_tokens ?? usage.output_tokens ?? null;
        } catch {
          // Error responses are not required to use the inference response schema.
        }
        let responseModel = null;
        try { responseModel = JSON.parse(responseBody)?.model || null; } catch { /* non-inference response */ }
        resolve({ response, actualTokens, inputTokens, outputTokens, requestedTokens, responseModel, responseBody });
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('token-rate-limit request timed out')));
    request.end(payload);
  });
}

async function createTokenRateLimitRecord(consumer, appConfig = null, options = {}) {
  const startedAt = new Date().toISOString();
  const { response, actualTokens, inputTokens, outputTokens, requestedTokens, responseModel } = await tokenRateLimitRequest(consumer, appConfig, options.session_id || null);
  tokenRateLimitSequence += 1;
  const status = response.statusCode || 0;
  const provider = response.headers['x-ai-demo-provider-gateway']
    || response.headers['x-grid-combined-provider-gateway']
    || response.headers['x-grid-llmd-provider-gateway']
    || null;
  const inferenceProvider = response.headers['x-ai-inference-provider']
    || response.headers['x-ai-demo-inference-provider']
    || null;
  const limit = parseOptionalInteger(rateLimitHeader(response.headers, 'x-ratelimit-limit'));
  const remaining = parseOptionalInteger(rateLimitHeader(response.headers, 'x-ratelimit-remaining'));
  const resetSeconds = parseOptionalInteger(rateLimitHeader(response.headers, 'x-ratelimit-reset'));
  const retryAfter = parseOptionalInteger(rateLimitHeader(response.headers, 'retry-after'));
  const governance = typeof response.headers['x-ratelimit-governance'] === 'string'
    ? response.headers['x-ratelimit-governance'] : null;
  const admitted = status >= 200 && status < 300;
  const unavailable = status === 503;
  const quotaDenied = status === 429 || status === 529;
  const externalProvider = Boolean(response.headers['x-openai-proxy-wasm']);
  const gatewayLabel = provider
    ? `${String(provider).replace(/\b\w/g, letter => letter.toUpperCase())} provider gateway`
    : 'OpenAI provider gateway';
  const reservationEstimate = appConfig?.estimateTokens || 5;
  const settlementAdjustment = actualTokens === null ? null : reservationEstimate - actualTokens;
  const record = {
    request_id: `live-${tokenRateLimitSequence}`,
    sequence: tokenRateLimitSequence,
    principal: TOKEN_RATE_LIMIT_USERNAME,
    model: appConfig?.model || TOKEN_RATE_LIMIT_MODEL,
    application: appConfig?.id || null,
    color: appConfig?.color || null,
    consumer_gateway: TOKEN_RATE_LIMIT_CONSUMER_LABELS[consumer] || `Consumer Gateway ${consumer.toUpperCase()}`,
    admission: admitted ? 'admitted' : unavailable ? 'unavailable' : quotaDenied ? 'denied' : 'provider_error',
    quota: {
      backend: 'Valkey (shared)',
      limit,
      used: null,
      remaining,
      reset_at: resetSeconds === null ? null : new Date(Date.now() + resetSeconds * 1000).toISOString(),
      retry_after_seconds: retryAfter,
      requested_tokens: requestedTokens,
      actual_tokens: actualTokens,
      reservation_estimate: reservationEstimate,
      settlement: actualTokens === null ? 'conservative_estimate'
        : settlementAdjustment > 0 ? 'refund'
          : settlementAdjustment < 0 ? 'overage' : 'exact',
      refund_tokens: settlementAdjustment > 0 ? settlementAdjustment : 0,
      overage_tokens: settlementAdjustment < 0 ? Math.abs(settlementAdjustment) : 0,
      governance,
    },
    requested_tokens: requestedTokens,
    response_model: responseModel,
    inference_provider: inferenceProvider,
    external_provider: externalProvider,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    session_id: options.session_id || null,
    route: {
      provider_gateway: provider,
      inference_provider: inferenceProvider,
      overlay_revision: response.headers['x-grid-overlay-revision'] || null,
      hops: admitted && provider
        ? externalProvider
          ? ['client', TOKEN_RATE_LIMIT_CONSUMER_LABELS[consumer] || `Consumer Gateway ${consumer.toUpperCase()}`, 'quota-admitted', gatewayLabel, inferenceProvider || 'OpenAI route', 'api.openai.com']
          : ['client', TOKEN_RATE_LIMIT_CONSUMER_LABELS[consumer] || `Consumer Gateway ${consumer.toUpperCase()}`, 'quota-admitted', provider, inferenceProvider || TOKEN_RATE_LIMIT_BACKEND_LABEL]
        : ['client', TOKEN_RATE_LIMIT_CONSUMER_LABELS[consumer] || `Consumer Gateway ${consumer.toUpperCase()}`, unavailable ? 'quota-unavailable' : quotaDenied ? 'quota-denied' : 'provider-error'],
    },
    http: { status, method: 'POST', path: '/v1/chat/completions' },
    trace: { trace_id: null, jaeger_url: null, spans: [] },
    started_at: startedAt,
    error: admitted ? null : {
      type: unavailable ? 'quota_backend_unavailable' : quotaDenied ? 'quota_exhausted' : 'provider_upstream_error',
      retry_after_seconds: retryAfter,
    },
  };
  tokenRateLimitHistory.push(record);
  if (tokenRateLimitHistory.length > TOKEN_RATE_LIMIT_HISTORY_LIMIT) tokenRateLimitHistory.shift();
  record.principal = appConfig?.username || TOKEN_RATE_LIMIT_USERNAME;
  record.quota.configured_limit = appConfig?.limit || TOKEN_RATE_LIMIT_CONFIGURED_LIMIT;
  record.quota.window_seconds = appConfig?.windowSeconds || TOKEN_RATE_LIMIT_WINDOW_SECONDS;
  if (appConfig) {
    const windowStart = Date.now() - appConfig.windowSeconds * 1000;
    const observedUsed = tokenRateLimitHistory
      .filter(item => item.application === appConfig.id && Date.parse(item.started_at) >= windowStart)
      .reduce((total, item) => total + (item.quota.actual_tokens || 0), 0);
    record.quota.remaining = Math.max(0, appConfig.limit - observedUsed);
    record.quota.governance = observedUsed > appConfig.limit
      ? 'over_allocation'
      : observedUsed >= appConfig.limit * 0.8 ? 'approaching' : 'within';
  }
  return record;
}

function liveTokenRateLimitData() {
  const providerDistribution = {};
  const consumerDistribution = { [TOKEN_RATE_LIMIT_CONSUMER_LABELS.a]: 0, [TOKEN_RATE_LIMIT_CONSUMER_LABELS.b]: 0 };
  for (const item of tokenRateLimitHistory) {
    consumerDistribution[item.consumer_gateway] = (consumerDistribution[item.consumer_gateway] || 0) + 1;
    if (item.route.provider_gateway) {
      providerDistribution[item.route.provider_gateway] = (providerDistribution[item.route.provider_gateway] || 0) + 1;
    }
  }
  const apps = TOKEN_RATE_LIMIT_APPS.map(app => {
    const items = tokenRateLimitHistory.filter(item => item.application === app.id);
    const latest = items.at(-1);
    const windowStart = Date.now() - app.windowSeconds * 1000;
    const activeItems = items.filter(item => Date.parse(item.started_at) >= windowStart);
    const used = activeItems.reduce((total, item) => total + (item.quota.actual_tokens || 0), 0);
    const earliestExpiry = activeItems.map(item => Date.parse(item.started_at) + app.windowSeconds * 1000).filter(Number.isFinite).sort((a, b) => a - b)[0] || null;
    return { id: app.id, name: app.name, username: app.username, model: app.model, color: app.color, limit: app.limit, estimate_tokens: app.estimateTokens, window_seconds: app.windowSeconds, used, raw_remaining: Math.max(0, app.limit - used), remaining: latest?.quota.remaining ?? Math.max(0, app.limit - used), governance: used > app.limit ? 'over_allocation' : used >= app.limit * 0.8 ? 'approaching' : 'within', next_expiry: latest?.quota.reset_at || (earliestExpiry ? new Date(earliestExpiry).toISOString() : null), admitted: items.filter(item => item.admission === 'admitted').length, denied: items.filter(item => item.admission === 'denied').length };
  });
  return {
    profile: 'token-rate-limit',
    source: 'live',
    principal: TOKEN_RATE_LIMIT_USERNAME,
    model: TOKEN_RATE_LIMIT_MODEL,
    multi_quota: TOKEN_RATE_LIMIT_MULTI_QUOTA,
    cloud_burst: TOKEN_CLOUD_BURST,
    apps,
    quota: {
      backend: 'Valkey (shared)',
      configured_limit: TOKEN_RATE_LIMIT_CONFIGURED_LIMIT,
      window_seconds: TOKEN_RATE_LIMIT_WINDOW_SECONDS,
      shared_key: `${TOKEN_RATE_LIMIT_USERNAME}/${TOKEN_RATE_LIMIT_MODEL}`,
    },
    policy: {
      algorithm: 'sliding_window',
      principal: TOKEN_RATE_LIMIT_USERNAME,
      model: TOKEN_RATE_LIMIT_MODEL,
      window_seconds: TOKEN_RATE_LIMIT_WINDOW_SECONDS,
      capacity_tokens: TOKEN_RATE_LIMIT_CONFIGURED_LIMIT,
      accounting: 'total_tokens',
      request_token_range: [TOKEN_RATE_LIMIT_MIN_TOKENS, TOKEN_RATE_LIMIT_MAX_TOKENS],
      max_tokens_per_request: TOKEN_RATE_LIMIT_MAX_TOKENS,
      backend: 'Valkey (shared)',
      unsupported_algorithms: {
        token_bucket: 'Not implemented',
        fixed_window: 'Not implemented',
        calendar_window: 'Not implemented',
      },
    },
    consumers: [TOKEN_RATE_LIMIT_CONSUMER_LABELS.a, TOKEN_RATE_LIMIT_CONSUMER_LABELS.b],
    consumer_distribution: consumerDistribution,
    provider_distribution: providerDistribution,
    timeline: tokenRateLimitHistory.map(item => ({
      at: item.started_at,
      label: `${item.consumer_gateway} · HTTP ${item.http.status}`,
      detail: item.route.provider_gateway || (item.admission === 'unavailable' ? 'Quota backend unavailable; no provider selected' : 'Quota denied; no provider selected'),
      state: item.admission,
    })),
    requests: [...tokenRateLimitHistory].reverse(),
  };
}

function tokenRateLimitFixture(state = 'recovered') {
  const now = Date.now();
  const iso = offset => new Date(now + offset).toISOString();
  const request = (id, admission, remaining, provider, status, offset, traceId, extra = {}) => ({
    request_id: id,
    principal: 'alice',
    model: 'canonical-model',
    consumer_gateway: extra.consumer_gateway || 'consumer-a',
    admission,
    quota: {
      backend: 'memory (shared)',
      limit: 100,
      used: 100 - remaining,
      remaining,
      reset_at: iso(60000),
      retry_after_seconds: admission === 'denied' ? 60 : null,
    },
    route: {
      provider_gateway: provider,
      overlay_revision: provider ? 'overlay-20260818-0042' : null,
      hops: provider ? ['consumer-gateway', 'quota-admission', 'intelligent_route', provider, TOKEN_RATE_LIMIT_BACKEND_LABEL] : ['consumer-gateway', 'quota-admission'],
    },
    http: { status: status, method: 'POST', path: '/v1/chat/completions' },
    trace: {
      trace_id: traceId,
      jaeger_url: `http://localhost:16686/trace/${traceId}`,
      spans: provider ? ['http.request', 'quota.check', 'routing.select', 'provider.forward', 'vcr.inference'] : ['http.request', 'quota.check'],
    },
    started_at: iso(offset),
    ...extra,
  });
  const admittedA = request('quota-001', 'admitted', 60, 'provider-a', 200, -240000, '11111111111111111111111111111111', { consumer_gateway: 'consumer-a' });
  const admittedB = request('quota-002', 'admitted', 40, 'provider-b', 200, -180000, '22222222222222222222222222222222', { consumer_gateway: 'consumer-b' });
  const denied = request('quota-003', 'denied', 0, null, 429, -120000, '33333333333333333333333333333333', {
    consumer_gateway: 'consumer-a',
    error: { type: 'quota_exhausted', message: 'shared token quota exhausted', retry_after_seconds: 60 },
  });
  const concurrent = request('quota-004', 'denied', 0, null, 429, -90000, '44444444444444444444444444444444', {
    consumer_gateway: 'consumer-b',
    concurrency: { contenders: 2, winner: 'quota-003', atomic_decision: true },
    error: { type: 'quota_exhausted', message: 'concurrent request rejected after atomic quota check', retry_after_seconds: 60 },
  });
  const recovered = request('quota-005', 'admitted', 80, 'provider-c', 200, -10000, '55555555555555555555555555555555', {
    consumer_gateway: 'consumer-b',
    recovery: { previous_state: 'exhausted', trigger: 'shared window expired', capacity_restored: true },
  });
  const requests = state === 'admitted' ? [admittedA, admittedB]
    : state === 'exhausted' ? [admittedA, admittedB, denied, concurrent]
      : state === 'concurrent-race' ? [admittedA, admittedB, concurrent]
        : [admittedA, admittedB, denied, concurrent, recovered];
  const admitted = requests.filter(item => item.admission === 'admitted');
  return {
    version: 'v1',
    profile: 'token-rate-limit',
    state,
    source: 'synthetic_fixture',
    generated_at: new Date(now).toISOString(),
    principal: 'alice',
    model: 'canonical-model',
    quota: { backend: 'memory (shared)', limit: 100, used: state === 'recovered' ? 20 : state === 'admitted' ? 60 : 100, remaining: state === 'recovered' ? 80 : state === 'admitted' ? 40 : 0, reset_at: iso(60000), shared_key: 'alice/canonical-model' },
    policy: {
      algorithm: 'sliding_window', principal: 'alice', model: 'canonical-model',
      window_seconds: 60, capacity_tokens: 100, backend: 'memory (shared)',
      accounting: 'total_tokens',
      unsupported_algorithms: { token_bucket: 'Not implemented', fixed_window: 'Not implemented', calendar_window: 'Not implemented' },
    },
    consumers: ['consumer-a', 'consumer-b'],
    provider_distribution: Object.fromEntries([...new Set(admitted.map(item => item.route.provider_gateway))].map(provider => [provider, admitted.filter(item => item.route.provider_gateway === provider).length])),
    requests,
    timeline: [
      { at: iso(-240000), label: 'Shared window opened', detail: 'alice/canonical-model quota available', state: 'available' },
      { at: iso(-120000), label: 'Quota exhausted', detail: 'Request denied before provider routing', state: 'exhausted' },
      { at: iso(-10000), label: 'Window expired', detail: 'Shared capacity restored and routing resumed', state: 'recovered' },
    ],
  };
}

const SCORING_WEIGHTS = { locality: 3.0, queue_depth: 5.0 };

const DEMO_SCENARIOS = {
  baseline: {
    label: 'Baseline',
    description: 'Pool A preferred — local advantage, low queue depth',
    pools: [
      { name: 'pool-a', kind: 'Local', region: 'pool-a', queue_depth: 0.1, kv_cache: 0.5, latency_ms: 25, cost_input: 0.001, cost_output: 0.002, healthy: true },
      { name: 'pool-b', kind: 'Remote', region: 'pool-b', queue_depth: 0.2, kv_cache: 0.5, latency_ms: 40, cost_input: 0.001, cost_output: 0.002, healthy: true },
    ],
  },
  pressure: {
    label: 'Pressure Failover',
    description: 'Pool A queue saturated — traffic shifts to Pool B',
    pools: [
      { name: 'pool-a', kind: 'Local', region: 'pool-a', queue_depth: 0.95, kv_cache: 0.5, latency_ms: 180, cost_input: 0.001, cost_output: 0.002, healthy: true },
      { name: 'pool-b', kind: 'Remote', region: 'pool-b', queue_depth: 0.2, kv_cache: 0.5, latency_ms: 40, cost_input: 0.001, cost_output: 0.002, healthy: true },
    ],
  },
  recovery: {
    label: 'Recovery',
    description: 'Pool A queue recovered — traffic returns to Pool A',
    pools: [
      { name: 'pool-a', kind: 'Local', region: 'pool-a', queue_depth: 0.1, kv_cache: 0.5, latency_ms: 25, cost_input: 0.001, cost_output: 0.002, healthy: true },
      { name: 'pool-b', kind: 'Remote', region: 'pool-b', queue_depth: 0.3, kv_cache: 0.4, latency_ms: 45, cost_input: 0.001, cost_output: 0.002, healthy: true },
    ],
  },
  degraded: {
    label: 'Pool A Degraded',
    description: 'Pool A unhealthy — all traffic to Pool B',
    pools: [
      { name: 'pool-a', kind: 'Local', region: 'pool-a', queue_depth: 0.1, kv_cache: 0.5, latency_ms: 25, cost_input: 0.001, cost_output: 0.002, healthy: false },
      { name: 'pool-b', kind: 'Remote', region: 'pool-b', queue_depth: 0.3, kv_cache: 0.5, latency_ms: 40, cost_input: 0.001, cost_output: 0.002, healthy: true },
    ],
  },
};

const DEMO_SCRIPTS = {
  presenter: {
    label: 'Presenter: baseline → pressure → recovery',
    description: 'A guided route story with visible provider pressure and traffic movement.',
    phases: [
      { scenario: 'baseline', label: 'Baseline', seconds: 5, requests: 3 },
      { scenario: 'pressure', label: 'Pressure and failover', seconds: 8, requests: 6 },
      { scenario: 'recovery', label: 'Recovery', seconds: 6, requests: 4 },
    ],
  },
  failure: {
    label: 'Presenter: provider degraded',
    description: 'Shows a provider becoming unavailable and the alternate route taking over.',
    phases: [
      { scenario: 'baseline', label: 'Baseline', seconds: 4, requests: 2 },
      { scenario: 'degraded', label: 'Provider unhealthy', seconds: 8, requests: 6 },
      { scenario: 'recovery', label: 'Recovery', seconds: 5, requests: 3 },
    ],
  },
};

// Deterministic mock trace history
let demoTraceCounter = 0;
const demoTraceHistory = [];

function emitEvent(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const client of eventClients) {
    try { client.write(payload); } catch { eventClients.delete(client); }
  }
}

function effectiveDemoMode(jaegerUp = false) {
  return ALLOW_SIMULATION && (currentMode === 'demo' || (currentMode === 'auto' && !jaegerUp));
}

// ---------------------------------------------------------------------------
// Scoring (mirrors Rust scoring crate logic)
// ---------------------------------------------------------------------------

function localityScore(kind) {
  switch (kind) {
    case 'Local': return 1.0;
    case 'Remote': return 0.4;
    case 'CloudManaged': return 0.2;
    case 'ApiProvider': return 0.1;
    default: return 0.1;
  }
}

function scorePool(pool) {
  if (!pool.healthy) return { score: 0, rank: -1 };
  if (typeof pool.score === 'number') return { score: pool.score, rank: 0 };
  const loc = localityScore(pool.kind) * SCORING_WEIGHTS.locality;
  const qd = typeof pool.queue_depth === 'number'
    ? (1.0 - pool.queue_depth) * SCORING_WEIGHTS.queue_depth
    : 0;
  return { score: parseFloat((loc + qd).toFixed(4)), rank: 0 };
}

function scoreAndRankPools(pools) {
  const scored = pools.map(p => ({ ...p, ...scorePool(p) }));
  scored.sort((a, b) => b.score - a.score);
  scored.forEach((p, i) => { p.rank = p.healthy ? i : -1; });
  return scored;
}

async function getGlbGatewayIp() {
  const { stdout } = await execFileAsync('kubectl', [
    '--context', GLB_KUBECTL_CONTEXT,
    '-n', GLB_GTM_NAMESPACE,
    'get', 'svc', GLB_GTM_SERVICE,
    '-o', 'jsonpath={.status.loadBalancer.ingress[0].ip}',
  ], { timeout: 5000 });
  const ip = stdout.trim();
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
    throw new Error('GTM service has no load-balancer IP');
  }
  return ip;
}

async function getGlbReadiness() {
  if (glbReadiness.expires > Date.now()) return glbReadiness;
  try {
    const ip = await getGlbGatewayIp();
    glbReadiness = { expires: Date.now() + 5000, available: true, ip, reason: null };
  } catch (error) {
    glbReadiness = { expires: Date.now() + 5000, available: false, reason: error.message };
  }
  return glbReadiness;
}

async function getVcrGatewayIp(targetPool = 'pool-a') {
  const context = targetPool === 'pool-b' ? VCR_CONTEXTS[1] : VCR_CONTEXTS[0];
  const { stdout } = await execFileAsync('kubectl', [
    '--context', context,
    '-n', VCR_NAMESPACE,
    'get', 'svc', VCR_GATEWAY_SERVICE,
    '-o', 'jsonpath={.status.loadBalancer.ingress[0].ip}',
  ], { timeout: 5000 });
  const ip = stdout.trim();
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
    throw new Error(`${VCR_GATEWAY_SERVICE} service has no load-balancer IP`);
  }
  return ip;
}

async function getVcrReadiness() {
  if (vcrReadiness.expires > Date.now()) return vcrReadiness;
  try {
    const ip = await getVcrGatewayIp();
    vcrReadiness = { expires: Date.now() + 5000, available: true, ip, reason: null };
  } catch (error) {
    vcrReadiness = { expires: Date.now() + 5000, available: false, reason: error.message };
  }
  return vcrReadiness;
}

function sendGlbRequest(ip, prompt, sequence) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      model: GLB_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 5,
    });
    const req = https.request({
      hostname: ip,
      port: 8443,
      path: '/v1/chat/completions',
      method: 'POST',
      rejectUnauthorized: false,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Edge-Session-Id': `dashboard-observe-${Date.now()}-${sequence}`,
      },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode || 0, ok: res.statusCode >= 200 && res.statusCode < 300 }));
    });
    req.on('error', (error) => resolve({ status: 0, ok: false, error: error.message }));
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.end(payload);
  });
}

function sendVcrRequest(ip, prompt, sequence, maxTokens = 5) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      model: VCR_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
    });
    const req = http.request({
      hostname: ip,
      port: VCR_GATEWAY_PORT,
      path: '/v1/chat/completions',
      method: 'POST',
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Session-Id': `dashboard-llmd-${Date.now()}-${sequence}`,
      },
    }, (res) => {
      const provider = res.headers['x-grid-llmd-provider-gateway'] || null;
      const consumerGateway = res.headers['x-grid-llmd-consumer-gateway'] || null;
      res.resume();
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        provider,
        consumer_gateway: consumerGateway,
      }));
    });
    req.on('error', (error) => resolve({ status: 0, ok: false, error: error.message }));
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.end(payload);
  });
}

async function runRequestJob(job, ip) {
  for (let i = 1; i <= job.count; i += 1) {
    if (job.cancelled) break;
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const result = await sendGlbRequest(ip, job.prompt, i);
    job.results.unshift({
      sequence: i,
      started_at: startedAt,
      status: result.status,
      ok: result.ok,
      duration_ms: Date.now() - started,
      trace_id: null,
      provider: null,
      route: 'Trace is still being indexed',
    });
    job.completed += 1;
    if (result.ok) job.succeeded += 1;
    else job.failed += 1;
    job.last_status = result.status;
    if (i < job.count && job.interval_ms > 0) {
      await new Promise(resolve => setTimeout(resolve, job.interval_ms));
    }
  }
  job.running = false;
  job.finished_at = new Date().toISOString();
}

async function runVcrRequestJob(job, ip) {
  for (let start = 1; start <= job.count && !job.cancelled; start += job.concurrency || 1) {
    const sequences = Array.from({ length: Math.min(job.concurrency || 1, job.count - start + 1) }, (_, offset) => start + offset);
    await Promise.all(sequences.map(async sequence => {
      const startedAt = new Date().toISOString();
      const started = Date.now();
      const result = await sendVcrRequest(ip, job.prompt, sequence, job.max_tokens);
      const generatedResult = {
        sequence,
        request_id: `llmd_req_${Date.now().toString(36)}_${sequence}`,
        started_at: startedAt,
        status: result.status,
        ok: result.ok,
        duration_ms: Date.now() - started,
        trace_id: null,
        provider: result.provider,
        consumer_gateway: result.consumer_gateway,
        route: result.provider ? `consumer-gateway → ${result.provider}` : 'Gateway response received',
      };
      job.results.unshift(generatedResult);
      liveGeneratedHistory.unshift(generatedResult);
      if (liveGeneratedHistory.length > 200) liveGeneratedHistory.length = 200;
      job.completed += 1;
      if (result.ok) job.succeeded += 1;
      else job.failed += 1;
      job.last_status = result.status;
      emitEvent('generation.progress', { job });
    }));
    if (start + sequences.length <= job.count && job.interval_ms > 0 && !job.cancelled) {
      await new Promise(resolve => setTimeout(resolve, job.interval_ms));
    }
  }
  job.running = false;
  job.finished_at = new Date().toISOString();
  emitEvent('generation.finished', { job });
}

// Sustained llm-d pressure is intentionally separate from Generate Requests.
// The selected pool is only the gateway where pressure enters; Grid remains
// responsible for the provider selected for each request.
async function runVcrLoadJob(job, ip) {
  if (job.mode === 'sustained') return runVcrSustainedLoadJob(job, ip);
  const deadline = Date.now() + job.duration_seconds * 1000;
  let sequence = 0;
  // Rate is the requested total requests/sec. Concurrency controls the burst
  // size, so the default 24 workers at 20 req/sec launch 24 requests about
  // every 1.2s while responses are attributed independently.
  const intervalMs = Math.max(50, Math.round(1000 * job.concurrency / job.rate_per_second));
  while (!job.cancelled && Date.now() < deadline) {
    const sequences = Array.from({ length: job.concurrency }, () => ++sequence);
    await Promise.all(sequences.map(async current => {
      const result = await sendVcrRequest(ip, job.prompt, `load-${job.id}-${current}`, job.max_tokens);
      job.completed += 1;
      if (result.ok) job.succeeded += 1;
      else job.failed += 1;
      job.last_status = result.status;
      job.last_provider = result.provider || null;
      job.last_consumer_gateway = result.consumer_gateway || null;
      if (result.provider) job.providers[result.provider] = (job.providers[result.provider] || 0) + 1;
      if (result.consumer_gateway) job.consumer_gateways[result.consumer_gateway] = (job.consumer_gateways[result.consumer_gateway] || 0) + 1;
      emitEvent('load.progress', { job });
    }));
    if (!job.cancelled && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
  job.running = false;
  job.finished_at = new Date().toISOString();
  job.stopped_reason = job.cancelled ? 'stopped by user' : 'duration complete';
  emitEvent('load.finished', { job });
}

async function runVcrSustainedLoadJob(job, ip) {
  const deadline = Date.now() + job.duration_seconds * 1000;
  let sequence = 0;
  let nextSlot = Date.now();
  const slotInterval = 1000 / job.rate_per_second;
  const waitForSlot = async () => {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + slotInterval;
    if (slot > now) await new Promise(resolve => setTimeout(resolve, slot - now));
  };
  const worker = async () => {
    while (!job.cancelled && Date.now() < deadline) {
      await waitForSlot();
      if (job.cancelled || Date.now() >= deadline) break;
      const result = await sendVcrRequest(ip, job.prompt, `load-${job.id}-${++sequence}`, job.max_tokens);
      job.completed += 1;
      if (result.ok) job.succeeded += 1;
      else job.failed += 1;
      job.last_status = result.status;
      job.last_provider = result.provider || null;
      job.last_consumer_gateway = result.consumer_gateway || null;
      if (result.provider) job.providers[result.provider] = (job.providers[result.provider] || 0) + 1;
      if (result.consumer_gateway) job.consumer_gateways[result.consumer_gateway] = (job.consumer_gateways[result.consumer_gateway] || 0) + 1;
      emitEvent('load.progress', { job });
    }
  };
  await Promise.all(Array.from({ length: job.concurrency }, worker));
  job.running = false;
  job.finished_at = new Date().toISOString();
  job.stopped_reason = job.cancelled ? 'stopped by user' : 'duration complete';
  emitEvent('load.finished', { job });
}

// ---------------------------------------------------------------------------
// Jaeger proxy helpers
// ---------------------------------------------------------------------------

function jaegerFetch(path, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const url = `${JAEGER_URL}${path}`;
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error(`timeout after ${timeoutMs}ms`)); });
  });
}

async function isJaegerReachable() {
  try {
    const result = await jaegerFetch('/api/services');
    return result.status === 200;
  } catch {
    return false;
  }
}

const JAEGER_SERVICES = [
  'grid-tracing-poc', 'consumer-gateway', 'praxis',
  'praxis-gtm-emulator', 'praxis-east-edge', 'praxis-west-edge',
  'praxis-east-provider', 'praxis-west-provider',
];

async function fetchLiveTraces(service, limit) {
  try {
    // Praxis traces contain many filter spans. Keep each service query bounded
    // so a large Jaeger response cannot make the UI appear empty on timeout.
    const result = await jaegerFetch(`/api/traces?service=${encodeURIComponent(service)}&limit=${limit}`, 10000);
    if (result.status !== 200 || !result.body.data) return [];
    return result.body.data.map(parseJaegerTrace).filter(Boolean);
  } catch (error) {
    console.warn(`[tracing] Jaeger query failed for service=${service}: ${error.message}`);
    return [];
  }
}

async function fetchLiveTracesAllServices(limit) {
  const perServiceLimit = Math.min(Math.max(limit, 20), 50);
  const allTraces = [];
  const seen = new Set();
  const serviceResults = await Promise.all(JAEGER_SERVICES.map(svc => fetchLiveTraces(svc, perServiceLimit)));
  for (const traces of serviceResults) {
    for (const t of traces) {
      if (!seen.has(t.trace_id)) {
        seen.add(t.trace_id);
        allTraces.push(t);
      }
    }
  }
  allTraces.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
  return allTraces.slice(0, limit);
}

function parseJaegerTrace(trace) {
  if (!trace.spans || trace.spans.length === 0) return null;
  const rootSpan = trace.spans.find(s => s.operationName === 'consumer.inbound')
    || trace.spans.find(s => s.operationName === 'http.request')
    || trace.spans[0];
  const routeSpan = trace.spans.find(s =>
    s.operationName === 'consumer.route_select' || s.operationName === 'routing.select');

  const getTag = (span, key) => {
    const tag = span?.tags?.find(t => t.key === key);
    return tag ? tag.value : null;
  };

  const libraryName = getTag(routeSpan || rootSpan, 'otel.library.name');
  let source = 'unknown';
  if (libraryName === 'praxis-ai') source = 'praxis';
  else if (libraryName === 'grid-tracing-poc') source = 'synthetic';

  const clientSpan = trace.spans.find(s =>
    getTag(s, 'span.kind') === 'client' || getTag(s, 'otel.kind') === 'CLIENT'
    || s.operationName === 'provider.request');
  const hasTraceparent = !!clientSpan;

  const processes = trace.processes || {};
  const serviceForProcess = processId => processes[processId]?.serviceName || null;

  const spans = trace.spans.map(s => {
    const kind = getTag(s, 'span.kind') || getTag(s, 'otel.kind') || 'internal';
    const refs = s.references || [];
    const parentRef = refs.find(r => r.refType === 'CHILD_OF');
    return {
      span_id: s.spanID,
      operation: s.operationName,
      service_name: serviceForProcess(s.processID),
      start_time_us: typeof s.startTime === 'number' ? s.startTime : null,
      kind: kind.toUpperCase(),
      duration_us: typeof s.duration === 'number' ? s.duration : null,
      parent_span_id: parentRef ? parentRef.spanID : null,
      tags: Object.fromEntries(
        (s.tags || [])
          .filter(t => !['internal.span.format', 'otel.library.name',
            'otel.library.version', 'code.filepath', 'code.namespace',
            'code.lineno', 'thread.id', 'thread.name',
            'busy_ns', 'idle_ns'].includes(t.key))
          .map(t => [t.key, t.value])
      ),
    };
  });

  // Jaeger does not guarantee process-map or span-array order. Reconstruct the
  // observed network path from the parent/child span graph so the UI describes
  // the request's causal order rather than ingestion order.
  const spansById = new Map(spans.map(span => [span.span_id, span]));
  const childrenByParent = new Map();
  for (const span of spans) {
    if (!span.parent_span_id) continue;
    const children = childrenByParent.get(span.parent_span_id) || [];
    children.push(span);
    childrenByParent.set(span.parent_span_id, children);
  }
  const roots = spans.filter(span => !span.parent_span_id);
  roots.sort((a, b) => (a.start_time_us || 0) - (b.start_time_us || 0));
  const path = [];
  const visited = new Set();
  const visit = span => {
    if (!span || visited.has(span.span_id)) return;
    visited.add(span.span_id);
    if (span.service_name && !path.includes(span.service_name)) path.push(span.service_name);
    const children = [...(childrenByParent.get(span.span_id) || [])]
      .sort((a, b) => (a.start_time_us || 0) - (b.start_time_us || 0));
    children.forEach(visit);
  };
  roots.forEach(visit);
  spans.forEach(visit);

  const runIds = Object.values(processes).flatMap(p => (p.tags || [])
    .filter(tag => tag.key === 'demo.run_id')
    .map(tag => tag.value));
  const demoRunId = runIds[0] || null;
  const serviceNames = path.filter(service => service !== 'jaeger-query');

  return {
    trace_id: trace.traceID,
    jaeger_url: `${JAEGER_UI_URL}/trace/${trace.traceID}`,
    span_count: trace.spans.length,
    service_count: serviceNames.length,
    services: serviceNames,
    source,
    demo_run_id: demoRunId,
    has_traceparent: hasTraceparent,
    // selected.provider is the model, not the selected backend identity.
    selected_provider: getTag(routeSpan, 'selected.provider') || 'unknown',
    selected_cluster: getTag(routeSpan, 'selected.cluster') || 'unknown',
    selected_site: getTag(routeSpan, 'selected.site') || null,
    stable_id: getTag(routeSpan, 'selected.stable_id') || null,
    admission_state: getTag(routeSpan, 'routing.admission_state') || null,
    overlay_revision: getTag(routeSpan, 'overlay.revision') || null,
    provider_score: getTag(routeSpan, 'provider.score') ?? null,
    routing_decision: getTag(routeSpan, 'routing.decision') || '',
    routing_policy: getTag(routeSpan, 'routing.policy') || null,
    routing_kind: getTag(routeSpan, 'routing.kind') || null,
    selection_tier: getTag(routeSpan, 'routing.selection_tier') || null,
    duration_us: typeof rootSpan.duration === 'number' ? rootSpan.duration : null,
    timestamp: rootSpan.startTime ? new Date(rootSpan.startTime / 1000).toISOString() : null,
    spans,
  };
}

async function fetchLivePoolState() {
  if (dataSource === 'vcr') {
    const live = await loadLiveVcrState();
    if (!live) return null;
    return {
      pools: live.providers.map(provider => ({
        ...provider,
        request_count: 0,
      })),
      latest_trace: null,
      scoring_strategy: live.scoring_strategy,
      overlay_revision: live.overlay_revision,
      generated_at: live.generated_at,
    };
  }

  const traces = filterRecentTraces(await fetchLiveTracesAllServices(100));
  if (traces.length === 0) return null;

  const latest = traces[0];
  const providerMap = new Map();
  for (const t of traces) {
    const id = t.stable_id || t.selected_cluster;
    if (!id || id === 'unknown') continue;
    if (!providerMap.has(id)) {
      providerMap.set(id, {
        name: t.selected_provider || id,
        cluster: t.selected_cluster || 'unknown',
        site: t.selected_site || null,
        stable_id: t.stable_id || null,
        admission_state: t.admission_state || null,
        selection_tier: t.selection_tier || null,
        overlay_revision: t.overlay_revision || null,
        healthy: true,
        score: typeof t.provider_score === 'number' ? t.provider_score : null,
        queue_depth: null,
        kv_cache: null,
        latency_ms: null,
        request_count: 0,
      });
    }
    providerMap.get(id).request_count++;
  }

  const pools = [...providerMap.values()];
  const hasAnyScore = pools.some(p => typeof p.score === 'number');
  const inferredStrategy = hasAnyScore ? 'unknown' : 'noMetrics';
  return { pools, latest_trace: latest, scoring_strategy: inferredStrategy };
}

const LIVE_TRACE_WINDOW_MS = 15 * 60 * 1000;

function filterRecentTraces(traces, from = Date.now() - LIVE_TRACE_WINDOW_MS) {
  return traces.filter(trace => {
    const timestamp = Date.parse(trace.timestamp || '');
    return Number.isFinite(timestamp) && timestamp >= from;
  });
}

// ---------------------------------------------------------------------------
// Pressure state classification
// ---------------------------------------------------------------------------

const PRESSURE_THRESHOLDS = [
  { max: 0.50, level: 'normal' },
  { max: 0.80, level: 'elevated' },
  { max: 0.95, level: 'high' },
  { max: Infinity, level: 'critical' },
];

function pressureLevel(value) {
  if (typeof value !== 'number' || !isFinite(value)) return 'unknown';
  for (const t of PRESSURE_THRESHOLDS) {
    if (value < t.max) return t.level;
  }
  return 'critical';
}

function classifyProvider(pool) {
  const activeSignal = typeof pool.queue_depth === 'number' ? pool.queue_depth
    : typeof pool.kv_cache === 'number' ? pool.kv_cache
    : null;
  return {
    pressure_level: activeSignal !== null ? pressureLevel(activeSignal) : 'unknown',
    pressure_value: activeSignal,
    pressure_source: typeof pool.queue_depth === 'number' ? 'queue_depth'
      : typeof pool.kv_cache === 'number' ? 'kv_cache'
      : null,
  };
}

// ---------------------------------------------------------------------------
// Overlay file support
// ---------------------------------------------------------------------------

const OVERLAY_FILE = process.env.OVERLAY_FILE || null;

function loadOverlayFromFile() {
  if (!OVERLAY_FILE) return null;
  try {
    return JSON.parse(readFileSync(OVERLAY_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function tokenOverlayProviders() {
  const overlay = loadOverlayFromFile();
  const candidates = overlay?.overlay?.candidates || overlay?.candidates;
  if (!Array.isArray(candidates)) return null;
  const hits = new Map();
  for (const item of tokenRateLimitHistory) {
    const provider = item.route?.provider_gateway;
    if (provider) hits.set(provider, (hits.get(provider) || 0) + 1);
  }
  return candidates.map((candidate, index) => {
    const identity = [candidate.site, candidate.cluster, candidate.name, candidate.stable_id]
      .filter(Boolean);
    const observedHits = identity.reduce((count, key) => count + (hits.get(key) || 0), 0);
    return {
      id: candidate.stable_id || candidate.cluster || candidate.site || `provider-${index}`,
      name: candidate.name || candidate.site,
      site: candidate.site || null,
      cluster: candidate.cluster || null,
      external: Boolean(candidate.external || candidate.backend_kind === 'api_provider' || candidate.backend_kind === 'cloud_managed' || /openai|bedrock|cloud/i.test(`${candidate.cluster || ''} ${candidate.site || ''}`)),
      backend_kind: candidate.backend_kind || null,
      stable_id: candidate.stable_id || null,
      admission_state: candidate.admission_state || null,
      selection_group: candidate.selection_group ?? 0,
      selection_tier: candidate.selection_tier || null,
      healthy: candidate.fresh !== false && candidate.admission_state !== 'excluded',
      rank: candidate.rank ?? index,
      score: typeof candidate.score === 'number' ? candidate.score : null,
      queue_depth: { value: observedHits },
      request_count: observedHits,
      pressure: 'normal',
    };
  });
}

// ---------------------------------------------------------------------------
// Demo mode helpers
// ---------------------------------------------------------------------------

function generateDemoTrace(scenario, pools) {
  demoTraceCounter++;
  const scored = scoreAndRankPools(pools);
  const selected = scored.find(p => p.healthy) || scored[0];
  const hex = demoTraceCounter.toString(16).padStart(32, '0');

  const trace = {
    request_id: `req_demo_${Date.now().toString(36)}_${demoTraceCounter.toString(36)}`,
    trace_id: hex,
    jaeger_url: `${JAEGER_UI_URL}/trace/${hex}`,
    span_count: 4,
    selected_provider: `llmd-${selected.name}-provider`,
    selected_cluster: selected.name,
    provider_score: selected.score,
    routing_decision: `scored ${scored.filter(p => p.healthy).length} backends, selected ${selected.name} (score=${selected.score.toFixed(2)})`,
    routing_policy: 'scoreFirst',
    duration_us: 15000 + demoTraceCounter * 100,
    timestamp: new Date().toISOString(),
    scenario: scenario,
    status: scenario === 'degraded' ? 503 : 200,
    completion: scenario === 'degraded' ? 'failed' : 'completed',
    model: 'Qwen/Qwen3-0.6B',
    ttft_ms: scenario === 'pressure' ? 420 : 95,
    retry_count: scenario === 'pressure' ? 1 : 0,
    failover: scenario === 'pressure',
    selection_queue_depth: selected.queue_depth,
    selection_kv_cache: selected.kv_cache,
    rank: selected.rank ?? null,
  };

  demoTraceHistory.unshift(trace);
  if (demoTraceHistory.length > 50) demoTraceHistory.length = 50;

  emitEvent('request.summary.created', { request: normalizeRequest(trace, 'demo') });

  return trace;
}

function experienceForRequest(request) {
  const status = Number(request.status || 0);
  const duration = Number(request.duration_ms || 0);
  const retryPenalty = Number(request.retry_count || 0) * 8;
  const statusPenalty = status >= 500 || status === 0 ? 45 : status >= 400 ? 20 : 0;
  const latencyPenalty = duration > 2000 ? 35 : duration > 1000 ? 18 : duration > 500 ? 8 : 0;
  const score = Math.max(0, Math.min(100, 100 - retryPenalty - statusPenalty - latencyPenalty));
  const label = score >= 90 ? 'excellent' : score >= 75 ? 'good' : score >= 55 ? 'degraded' : 'poor';
  const reliability = status >= 500 || status === 0 ? 20 : status >= 400 ? 65 : 100;
  const latency = duration > 2000 ? 35 : duration > 1000 ? 65 : duration > 500 ? 85 : 100;
  const routing = request.routing?.failover ? 84 : 100;
  const technical = request.trace_quality === 'missing' ? 60 : 95;
  const confidence = request.trace_quality === 'exact' ? 100 : request.trace_quality === 'simulated' ? 70 : 80;
  return {
    score, label,
    components: { reliability, latency, routing, technical, confidence },
    reasons: [
      status >= 400 ? `HTTP ${status || 'unknown'} response` : 'HTTP success',
      duration ? `${Math.round(duration)}ms total latency` : 'total latency unavailable',
      request.ttft_ms ? `${Math.round(request.ttft_ms)}ms time to first token` : 'TTFT unavailable',
      request.retry_count ? `${request.retry_count} retry/failover${request.retry_count === 1 ? '' : 's'}` : 'no retry observed',
    ],
    quality: request.trace_quality || 'simulated',
  };
}

function normalizeRequest(trace, source = 'jaeger') {
  const durationMs = typeof trace.duration_ms === 'number'
    ? trace.duration_ms
    : typeof trace.duration_us === 'number' ? trace.duration_us / 1000 : null;
  // Only expose a Jaeger link when this row represents a trace that was
  // actually indexed by Jaeger. Demo rows and gateway-attributed VCR rows
  // deliberately have no raw trace; linking them to `#` is misleading and
  // leaves the browser at the dashboard URL with a confusing fragment.
  const hasIndexedTrace = source === 'jaeger' || trace.trace_quality === 'exact';
  const request = {
    request_id: trace.request_id || `req_${trace.trace_id}`,
    trace_id: trace.trace_id,
    jaeger_url: hasIndexedTrace && (trace.jaeger_url || trace.trace_id)
      ? (trace.jaeger_url || `${JAEGER_UI_URL}/trace/${trace.trace_id}`)
      : null,
    started_at: trace.timestamp,
    duration_ms: durationMs,
    ttft_ms: trace.ttft_ms ?? null,
    status: trace.status ?? 200,
    completion: trace.completion || 'completed',
    model: trace.model || 'unknown',
    provider: {
      stable_id: trace.stable_id || trace.selected_cluster || 'unknown',
      site: trace.selected_site || null,
      cluster: trace.selected_cluster || 'unknown',
      // selected_provider is the requested model (for example Qwen/Qwen3-0.6B).
      // Use the selected cluster as the provider identity in request views.
      name: trace.selected_cluster || trace.selected_site || 'unknown',
    },
    routing: {
    rank: trace.rank ?? null,
      score: trace.provider_score ?? null,
      admission_state: trace.admission_state || null,
      selection_tier: trace.selection_tier || null,
      overlay_revision: trace.overlay_revision || null,
      decision: trace.routing_decision || null,
      policy: trace.routing_policy || null,
      retry_count: trace.retry_count ?? 0,
      failover: Boolean(trace.failover),
    },
    trace_quality: trace.trace_quality || (source === 'demo' ? 'simulated' : trace.span_count ? 'exact' : 'missing'),
    source: source === 'demo' ? 'simulated' : source,
    services: trace.services || [],
    span_count: trace.span_count || trace.spans?.length || 0,
    spans: trace.spans || [],
    provenance: {
      request: source === 'demo' ? 'demo scenario' : source === 'gateway' ? 'consumer gateway response' : 'Jaeger trace',
      routing: source === 'gateway'
        ? 'gateway attribution header'
        : trace.provider_score != null ? 'OTel routing span' : 'not observed',
      pressure: 'not available at request boundary',
    },
    selection_time_metrics: {
      queue_depth: trace.selection_queue_depth == null ? null : {
        value: trace.selection_queue_depth,
        quality: source === 'demo' ? 'simulated' : 'exact',
        source: source === 'demo' ? 'demo_scenario' : 'epp',
        observed_at: trace.timestamp,
      },
      kv_cache: trace.selection_kv_cache == null ? null : {
        value: trace.selection_kv_cache,
        quality: source === 'demo' ? 'simulated' : 'exact',
        source: source === 'demo' ? 'demo_scenario' : 'epp',
        observed_at: trace.timestamp,
      },
    },
  };
  request.experience = experienceForRequest(request);
  return request;
}

function normalizeGeneratedRequest(result) {
  const provider = result.provider || 'unknown';
  return normalizeRequest({
    request_id: result.request_id,
    trace_id: null,
    timestamp: result.started_at,
    duration_ms: result.duration_ms,
    status: result.status,
    completion: result.ok ? 'completed' : 'failed',
    model: VCR_MODEL,
    selected_cluster: provider,
    services: ['consumer-gateway', provider],
    trace_quality: 'sampled',
    routing_decision: 'gateway attribution header',
  }, 'gateway');
}

function requestDataset() {
  if (effectiveDemoMode(false)) {
    return demoTraceHistory.map(trace => normalizeRequest(trace, 'demo'));
  }
  return null;
}

function encodeCursor(offset, filterHash) {
  return Buffer.from(JSON.stringify({ v: 1, offset, filter_hash: filterHash })).toString('base64url');
}

function decodeCursor(value) {
  if (!value) return { offset: 0, filter_hash: null };
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { return null; }
}

async function normalizedRequestDataset() {
  const demo = requestDataset();
  if (demo) return demo;
  const traces = await fetchLiveTracesAllServices(100);
  const requests = traces.map(trace => normalizeRequest(trace, trace.source === 'unknown' ? 'jaeger' : trace.source));
  if (dataSource === 'vcr' && liveGeneratedHistory.length) {
    requests.push(...liveGeneratedHistory.map(normalizeGeneratedRequest));
    requests.sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));
  }
  if (dataSource === 'vcr') {
    const live = await loadLiveVcrState();
    if (live?.providers?.length) {
      const providers = new Map(live.providers.map(provider => [provider.site || provider.cluster || provider.name, provider]));
      for (const request of requests) {
        const provider = providers.get(request.provider.site) || providers.get(request.provider.cluster) || providers.get(request.provider.name);
        if (!provider) continue;
        request.selection_time_metrics = {
          queue_depth: provider.queue_depth ? { value: provider.queue_depth.value, quality: 'sampled', source: provider.queue_depth.source || 'epp', observed_at: live.generated_at } : null,
          kv_cache: provider.kv_cache ? { value: provider.kv_cache.value, quality: 'sampled', source: provider.kv_cache.source || 'epp', observed_at: live.generated_at } : null,
        };
        request.provenance.pressure = 'latest EPP sample correlated to selected provider; not exact selection-time evidence';
      }
    }
  }
  return requests;
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

app.get('/api/status', async (_req, res) => {
  const jaegerUp = await isJaegerReachable();
  let effectiveMode = currentMode;
  if (currentMode === 'auto') {
    effectiveMode = jaegerUp ? 'live' : ALLOW_SIMULATION ? 'demo' : 'unavailable';
  }

  let liveDetail = null;
  if (effectiveMode === 'live' && jaegerUp) {
    const traces = await fetchLiveTracesAllServices(5);
    const hasPraxis = traces.some(t => t.source === 'praxis');
    const hasSynthetic = traces.some(t => t.source === 'synthetic');
    liveDetail = hasPraxis ? 'praxis' : hasSynthetic ? 'synthetic' : 'live';
  }

  const liveVcr = await loadLiveVcrState();
  const vcrEvidenceAvailable = !!VCR_EVIDENCE_DIR && existsSync(VCR_EVIDENCE_DIR);
  const vcrAvailable = !!liveVcr || vcrEvidenceAvailable;
  const glbAvailable = dataSource === 'glb' ? (await getGlbReadiness()).available : false;
  const sourceLabel = TOKEN_RATE_LIMIT_LIVE
    ? 'LIVE TOKEN QUOTA'
    : dataSource === 'glb'
    ? (effectiveMode === 'demo' ? 'MOCK DATA' : effectiveMode === 'live' && glbAvailable ? 'LIVE PRAXIS / GLB' : 'UNAVAILABLE')
    : dataSource === 'vcr'
    ? (vcrAvailable ? 'LIVE EPP / VCR' : 'UNAVAILABLE')
    : 'COMBINED';

  res.json({
    mode: effectiveMode,
    configured_mode: currentMode,
    jaeger_reachable: jaegerUp,
    jaeger_url: JAEGER_URL,
    live_detail: liveDetail,
    scenario: effectiveMode === 'demo' ? demoScenario : null,
    data_source: dataSource,
    source_label: sourceLabel,
    vcr_available: vcrAvailable || TOKEN_RATE_LIMIT_LIVE,
    vcr_mode: liveVcr ? 'live' : vcrEvidenceAvailable ? 'evidence' : 'unavailable',
  });
});

app.post('/api/mode', (req, res) => {
  const { mode } = req.body;
  if (!['auto', 'live', 'demo'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be auto, live, or demo' });
  }
  if (mode === 'demo' && !ALLOW_SIMULATION) {
    return res.status(403).json({ error: 'simulation is disabled', reason: 'Set ALLOW_SIMULATION=true explicitly for local synthetic demo data.' });
  }
  currentMode = mode;
  if (mode === 'demo') {
    demoScenario = 'baseline';
    demoTraceHistory.length = 0;
    demoTraceCounter = 0;
  }
  res.json({ mode: currentMode });
});

app.get('/api/pools', async (_req, res) => {
  const jaegerUp = await isJaegerReachable();
  let effectiveMode = currentMode === 'auto' ? (jaegerUp ? 'live' : ALLOW_SIMULATION ? 'demo' : 'unavailable') : currentMode;
  if (effectiveMode === 'live' && !jaegerUp) effectiveMode = currentMode === 'auto' && ALLOW_SIMULATION ? 'demo' : 'unavailable';

  if (effectiveMode === 'live' && jaegerUp) {
    const liveState = dataSource === 'glb' && !(await getGlbReadiness()).available
      ? null
      : await fetchLivePoolState();
    if (liveState) {
      const scored = scoreAndRankPools(liveState.pools);
      return res.json({ mode: 'live', pools: scored, latest_trace: liveState.latest_trace });
    }
    effectiveMode = 'unavailable';
  }

  if (effectiveMode === 'unavailable') {
    return res.json({ mode: 'unavailable', pools: [], latest_trace: null, warning: 'No live telemetry source is available; simulation is disabled.' });
  }

  const scenario = DEMO_SCENARIOS[demoScenario] || DEMO_SCENARIOS.baseline;
  const scored = scoreAndRankPools(scenario.pools);
  const trace = generateDemoTrace(demoScenario, scenario.pools);

  res.json({
    mode: effectiveMode === 'live' ? 'unavailable' : 'demo',
    pools: scored,
    latest_trace: trace,
    scenario: { name: demoScenario, ...scenario },
  });
});

app.get('/api/traces', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
  const jaegerUp = await isJaegerReachable();
  let effectiveMode = currentMode === 'auto' ? (jaegerUp ? 'live' : ALLOW_SIMULATION ? 'demo' : 'unavailable') : currentMode;
  if (effectiveMode === 'live' && !jaegerUp) effectiveMode = currentMode === 'auto' && ALLOW_SIMULATION ? 'demo' : 'unavailable';

  if (effectiveMode === 'live' && jaegerUp) {
    const from = req.query.from ? Date.parse(req.query.from) : Date.now() - LIVE_TRACE_WINDOW_MS;
    const traces = filterRecentTraces(
      await fetchLiveTracesAllServices(Math.max(limit, 100)),
      Number.isFinite(from) ? from : undefined,
    ).slice(0, limit);
    return res.json({ mode: 'live', traces });
  }

  res.json({
    mode: effectiveMode,
    traces: effectiveMode === 'demo' ? demoTraceHistory.slice(0, limit) : [],
    ...(effectiveMode === 'unavailable' ? { warning: 'No live trace source is available; simulation is disabled.' } : {}),
  });
});

app.post('/api/scenario/:name', (req, res) => {
  const { name } = req.params;
  if (!DEMO_SCENARIOS[name]) {
    return res.status(400).json({ error: `unknown scenario: ${name}`, available: Object.keys(DEMO_SCENARIOS) });
  }
  if (!ALLOW_SIMULATION) return res.status(403).json({ error: 'simulation is disabled', reason: 'Set ALLOW_SIMULATION=true explicitly for local synthetic scenarios.' });
  demoScenario = name;
  const scenario = DEMO_SCENARIOS[name];
  const scored = scoreAndRankPools(scenario.pools);
  const trace = generateDemoTrace(name, scenario.pools);

  res.json({
    scenario: { name, ...scenario },
    pools: scored,
    trace,
  });
});

app.get('/api/trace/:traceId', async (req, res) => {
  const { traceId } = req.params;
  const simulatedTrace = demoTraceHistory.find(trace => trace.trace_id === traceId);
  if (simulatedTrace && effectiveDemoMode(false)) {
    return res.json({ ...simulatedTrace, source: 'synthetic', spans: [], span_count: 0 });
  }
  try {
    const result = await jaegerFetch(`/api/traces/${traceId}`);
    if (result.status !== 200 || !result.body.data || result.body.data.length === 0) {
      return res.status(404).json({ error: 'trace not found' });
    }
    const parsed = parseJaegerTrace(result.body.data[0]);
    if (!parsed) return res.status(404).json({ error: 'trace parse failed' });
    res.json(parsed);
  } catch {
    res.status(502).json({ error: 'jaeger unreachable' });
  }
});

app.get('/api/overlay', (_req, res) => {
  const overlay = loadOverlayFromFile();
  if (!overlay) {
    return res.json({ available: false, source: null, overlay: null });
  }
  res.json({ available: true, source: OVERLAY_FILE, overlay });
});

app.get('/api/providers', async (_req, res) => {
  if (TOKEN_RATE_LIMIT_PROFILE && TOKEN_RATE_LIMIT_LIVE) {
    const providers = tokenOverlayProviders();
    if (providers) {
      const overlay = loadOverlayFromFile();
      return res.json({
        mode: 'live',
        scoring_strategy: 'noMetrics',
        selection_mode: 'roundRobin',
        providers,
        overlay_revision: overlay?.revision?.value || null,
        generated_at: overlay?.overlay?.generated_at || null,
      });
    }
    return res.json({
      mode: 'unavailable',
      scoring_strategy: null,
      providers: [],
      warning: 'The accepted token-quota routing overlay is not available.',
    });
  }
  const jaegerUp = await isJaegerReachable();
  const effectiveMode = currentMode === 'auto' ? (jaegerUp ? 'live' : ALLOW_SIMULATION ? 'demo' : 'unavailable') : currentMode;
  const resolvedMode = effectiveMode === 'live' && !jaegerUp ? (currentMode === 'auto' && ALLOW_SIMULATION ? 'demo' : 'unavailable') : effectiveMode;

  if (resolvedMode === 'live' && dataSource === 'glb' && !(await getGlbReadiness()).available) {
    return res.json({ mode: 'unavailable', scoring_strategy: null, providers: [], warning: 'The GLB gateway is unavailable; historical Jaeger traces are not used as current GLB provider state.' });
  }
  if (resolvedMode === 'live' && dataSource === 'vcr' && !(await loadLiveVcrState()) && !(VCR_EVIDENCE_DIR && existsSync(VCR_EVIDENCE_DIR))) {
    return res.json({ mode: 'unavailable', scoring_strategy: null, providers: [], warning: 'The llm-d/VCR EPP source is unavailable; historical Jaeger traces are not used as current VCR provider state.' });
  }

  if (resolvedMode === 'live' && jaegerUp) {
    const liveState = await fetchLivePoolState();
    if (liveState) {
      const overlay = loadOverlayFromFile();
      const candidateMap = new Map();
      if (overlay?.overlay?.candidates) {
        for (const c of overlay.overlay.candidates) {
          candidateMap.set(c.stable_id, c);
        }
      }

      const providers = liveState.pools.map(p => {
        const overlayCandidate = candidateMap.get(p.stable_id) || null;
        return {
          ...p,
          selection_tier: p.selection_tier || overlayCandidate?.selection_tier || null,
          score: typeof p.score === 'number' ? p.score
            : (typeof overlayCandidate?.score === 'number' ? overlayCandidate.score : null),
          rank: overlayCandidate?.rank ?? null,
          score_breakdown: overlayCandidate?.score_breakdown || null,
          ...classifyProvider(p),
        };
      });

      const scoringStrategy = liveState.scoring_strategy !== 'unknown'
        ? liveState.scoring_strategy
        : (overlay ? 'noMetrics' : 'unknown');

      return res.json({
        mode: 'live',
        scoring_strategy: scoringStrategy,
        providers,
        latest_trace: liveState.latest_trace,
        overlay_revision: overlay?.revision?.value || null,
      });
    }
  }

  const overlay = loadOverlayFromFile();
  if (resolvedMode === 'unavailable' && !overlay) {
    return res.json({ mode: 'unavailable', scoring_strategy: null, providers: [], warning: 'No live provider source is available; simulation is disabled.' });
  }
  if (overlay?.overlay?.candidates) {
    const providers = overlay.overlay.candidates.map(c => ({
      name: c.name,
      cluster: c.cluster,
      site: c.site,
      stable_id: c.stable_id,
      admission_state: c.admission_state,
      selection_tier: c.selection_tier,
      healthy: c.fresh !== false,
      score: typeof c.score === 'number' ? c.score : null,
      rank: typeof c.rank === 'number' ? c.rank : null,
      score_breakdown: c.score_breakdown || null,
      queue_depth: null,
      kv_cache: null,
      latency_ms: null,
      request_count: 0,
      ...classifyProvider({ queue_depth: null, kv_cache: null }),
    }));
    return res.json({
      mode: 'overlay',
      scoring_strategy: 'noMetrics',
      providers,
      overlay_revision: overlay.revision?.value || null,
      generated_at: overlay.overlay?.generated_at || null,
    });
  }

  const scenario = DEMO_SCENARIOS[demoScenario] || DEMO_SCENARIOS.baseline;
  const scored = scoreAndRankPools(scenario.pools);
  res.json({
    mode: 'demo',
    scoring_strategy: 'demo',
    providers: scored.map(p => ({ ...p, ...classifyProvider(p) })),
    scenario: { name: demoScenario, ...scenario },
  });
});

app.get('/api/timeline', async (_req, res) => {
  const jaegerUp = await isJaegerReachable();
  const effectiveMode = currentMode === 'auto' ? (jaegerUp ? 'live' : ALLOW_SIMULATION ? 'demo' : 'unavailable') : currentMode;
  const resolvedMode = effectiveMode === 'live' && !jaegerUp ? (currentMode === 'auto' && ALLOW_SIMULATION ? 'demo' : 'unavailable') : effectiveMode;

  if (resolvedMode === 'live' && jaegerUp) {
    const traces = await fetchLiveTracesAllServices(50);
    const events = buildTimelineFromTraces(traces);
    return res.json({ mode: 'live', events });
  }

  res.json({ mode: resolvedMode, events: resolvedMode === 'demo' ? buildDemoTimeline() : [], ...(resolvedMode === 'unavailable' ? { warning: 'No live timeline source is available; simulation is disabled.' } : {}) });
});

function buildTimelineFromTraces(traces) {
  if (!traces.length) return [];
  const noMetricsView = traces.every(trace => trace.provider_score === null || trace.provider_score === undefined);
  const events = [];
  const sorted = [...traces].sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  let prevProvider = null;
  let prevCluster = null;
  let prevEdge = null;

  for (const t of sorted) {
    const ts = t.timestamp ? new Date(t.timestamp) : null;
    const timeLabel = ts ? ts.toLocaleTimeString() : '—';
    const cluster = t.selected_cluster || 'unknown';
    const provider = t.selected_provider || 'unknown';
    const edge = (t.services || []).find(service => service.endsWith('-edge')) || null;
    const edgeLabel = edge ? edge.replace(/^praxis-/, '') : 'edge unavailable';
    const providerLabel = cluster;

    if (prevCluster && cluster !== prevCluster) {
      const previousEdgeLabel = prevEdge ? prevEdge.replace(/^praxis-/, '') : 'edge unavailable';
      const previousProviderLabel = prevCluster;
      events.push({
        time: timeLabel,
        type: 'route_change',
        label: noMetricsView
          ? `Observed path changed: ${previousEdgeLabel}/${previousProviderLabel} → ${edgeLabel}/${providerLabel}`
          : `Route changed: ${prevCluster} → ${cluster}`,
        detail: noMetricsView
          ? `Observed path: ${(t.services || []).map(service => service.replace(/^praxis-/, '')).join(' → ') || 'service path unavailable'}; no pressure signal in this view (trace ${t.trace_id.substring(0, 16)})`
          : `Trace ${t.trace_id.substring(0, 16)}`,
        severity: 'warning',
      });
    }

    if (!prevProvider) {
      events.push({
        time: timeLabel,
        type: 'baseline',
        label: `Baseline: ${cluster} selected`,
        detail: `Provider ${provider}, stable_id ${t.stable_id || '—'}`,
        severity: 'info',
      });
    }

    prevProvider = provider;
    prevCluster = cluster;
    prevEdge = edge;
  }

  const attribution = {};
  for (const t of sorted) {
    const c = t.selected_cluster || 'unknown';
    attribution[c] = (attribution[c] || 0) + 1;
  }
  events.push({
    time: 'summary',
    type: 'attribution',
    label: noMetricsView ? 'Observed trace attribution' : 'Request attribution',
    detail: Object.entries(attribution).map(([k, v]) => `${k}: ${v}`).join(', '),
    severity: 'info',
  });

  return events;
}

function buildDemoTimeline() {
  return [
    { time: '00:00', type: 'baseline', label: 'Baseline: pool-a preferred', detail: 'Local advantage, low queue depth', severity: 'info' },
    { time: '00:12', type: 'load_started', label: 'Stress generator started', detail: 'Demo scenario: pressure', severity: 'info' },
    { time: '00:21', type: 'threshold_crossed', label: 'Queue depth increased', detail: '0.10 → 0.95', severity: 'warning' },
    { time: '00:27', type: 'threshold_crossed', label: 'Pressure crossed CRITICAL', detail: 'queue_depth ≥ 0.95', severity: 'critical' },
    { time: '00:32', type: 'route_change', label: 'Route changed: pool-a → pool-b', detail: 'Score gap inverted', severity: 'warning' },
    { time: '01:10', type: 'load_stopped', label: 'Stress stopped', detail: 'Demo scenario: recovery', severity: 'info' },
    { time: '01:29', type: 'baseline', label: 'pool-a restored as preferred', detail: 'Queue drained below threshold', severity: 'info' },
  ];
}

app.get('/api/scenarios', (_req, res) => {
  const scenarios = Object.entries(DEMO_SCENARIOS).map(([key, val]) => ({
    key,
    label: val.label,
    description: val.description,
  }));
  res.json({ scenarios });
});

app.get('/api/v1/demo/scripts', (_req, res) => {
  res.json({ scripts: Object.entries(DEMO_SCRIPTS).map(([id, script]) => ({ id, label: script.label, description: script.description, duration_seconds: script.phases.reduce((sum, phase) => sum + phase.seconds, 0) })) });
});

app.get('/api/v1/demo/status', (_req, res) => {
  res.json({ available: Boolean(demoRun), run: demoRun });
});

app.post('/api/v1/demo/runs', async (req, res) => {
  const scriptId = req.body?.script_id || 'presenter';
  const script = DEMO_SCRIPTS[scriptId];
  if (!script) return res.status(400).json({ error: 'unknown demo script', available: Object.keys(DEMO_SCRIPTS) });
  if (demoRun?.running) return res.status(409).json({ error: 'demo script already running', run: demoRun });
  const jaegerUp = await isJaegerReachable();
  if (!effectiveDemoMode(jaegerUp)) return res.status(403).json({ error: 'demo scripts require demo mode or an unavailable live backend', reason: 'Use a live request target when observing a real environment.' });
  demoRun = { id: `demo-run-${Date.now().toString(36)}`, script_id: scriptId, label: script.label, running: true, phase_index: -1, phase: 'Starting', started_at: new Date().toISOString(), completed_requests: 0, total_requests: script.phases.reduce((sum, phase) => sum + phase.requests, 0) };
  emitEvent('demo.started', { run: demoRun });
  (async () => {
    for (let index = 0; index < script.phases.length; index += 1) {
      if (!demoRun?.running) break;
      const phase = script.phases[index];
      demoRun.phase_index = index;
      demoRun.phase = phase.label;
      demoScenario = phase.scenario;
      emitEvent('demo.phase', { run: demoRun, expected: DEMO_SCENARIOS[phase.scenario].description });
      for (let request = 0; request < phase.requests; request += 1) {
        if (!demoRun?.running) break;
        generateDemoTrace(phase.scenario, DEMO_SCENARIOS[phase.scenario].pools);
        demoRun.completed_requests += 1;
        emitEvent('demo.progress', { run: demoRun });
        await new Promise(resolve => setTimeout(resolve, Math.max(250, Math.round((phase.seconds * 1000) / phase.requests))));
      }
    }
    if (demoRun) {
      demoRun.running = false;
      demoRun.phase = 'Complete';
      demoRun.finished_at = new Date().toISOString();
      emitEvent('demo.completed', { run: demoRun });
    }
  })().catch(error => {
    if (demoRun) { demoRun.running = false; demoRun.phase = 'Error'; demoRun.error = error.message; }
    emitEvent('demo.failed', { run: demoRun });
  });
  res.status(202).json({ run: demoRun });
});

app.post('/api/v1/demo/stop', (_req, res) => {
  if (demoRun?.running) { demoRun.running = false; demoRun.phase = 'Stopped'; demoRun.finished_at = new Date().toISOString(); emitEvent('demo.stopped', { run: demoRun }); }
  res.json({ run: demoRun });
});

// ---------------------------------------------------------------------------
// Data source selector
// ---------------------------------------------------------------------------

app.get('/api/source', (_req, res) => {
  res.json({
    source: dataSource,
    available: {
      glb: !TOKEN_RATE_LIMIT_PROFILE,
      vcr: true,
      combined: !TOKEN_RATE_LIMIT_PROFILE,
    },
  });
});

app.post('/api/source', (req, res) => {
  if (TOKEN_RATE_LIMIT_PROFILE) {
    return res.status(409).json({ error: 'source switching is disabled in the token-rate-limit profile' });
  }
  const { source } = req.body;
  if (!['glb', 'vcr', 'combined'].includes(source)) {
    return res.status(400).json({ error: 'source must be glb, vcr, or combined' });
  }
  if (dataSource !== source && requestJob?.running) {
    requestJob.cancelled = true;
  }
  if (dataSource !== source && loadJob?.running) {
    loadJob.cancelled = true;
  }
  if (dataSource !== source) requestJob = null;
  dataSource = source;
  res.json({ source: dataSource });
});

// ---------------------------------------------------------------------------
// Live GLB request generator
// ---------------------------------------------------------------------------

app.get('/api/generate/status', (_req, res) => {
  isJaegerReachable().then(jaegerUp => {
  const simulated = effectiveDemoMode(jaegerUp);
  if (simulated) {
    return res.json({
      available: true,
      target: 'simulated',
      reason: 'Demo requests are generated locally and labeled SIMULATED.',
      job: requestJob,
    });
  }
  if (dataSource === 'vcr') {
    getVcrReadiness().then(readiness => res.json({
      available: readiness.available,
      target: 'llmd-gateway',
      reason: readiness.available ? null : `llm-d consumer gateway unavailable: ${readiness.reason}`,
      job: requestJob,
    }));
    return;
  }
  if (dataSource === 'combined') {
    return res.json({
      available: false,
      target: 'combined-gateway',
      reason: 'Combined-site live evidence is available, but request generation is not configured for this topology.',
      job: requestJob,
    });
  }
  getGlbReadiness().then(readiness => res.json({
    available: readiness.available,
    target: 'glb-gateway',
    reason: readiness.available ? null : `GLB gateway unavailable: ${readiness.reason}`,
    job: requestJob,
  }));
  });
});

app.post('/api/generate', async (req, res) => {
  if (requestJob?.running) {
    return res.status(409).json({ error: 'A request generation job is already running', job: requestJob });
  }

  const count = Math.min(100, Math.max(1, Number.parseInt(req.body?.count ?? 10, 10) || 10));
  const rate = Math.min(20, Math.max(0.1, Number(req.body?.rate ?? 1) || 1));
  const prompt = typeof req.body?.prompt === 'string' && req.body.prompt.trim()
    ? req.body.prompt.trim().slice(0, 500)
    : 'dashboard observability request';

  const simulated = effectiveDemoMode(await isJaegerReachable());
  if (simulated) {
    requestJob = {
      id: `demo-${Date.now()}`,
      running: true,
      target: 'simulated',
      count,
      rate_per_second: rate,
      interval_ms: Math.round(1000 / rate),
      prompt,
      completed: 0,
      succeeded: 0,
      failed: 0,
      last_status: null,
      results: [],
      started_at: new Date().toISOString(),
      finished_at: null,
    };
    const scenario = demoScenario;
    (async () => {
      for (let i = 0; i < count && !requestJob.cancelled; i += 1) {
        const trace = generateDemoTrace(scenario, DEMO_SCENARIOS[scenario].pools);
        requestJob.results.unshift({
          sequence: i + 1,
          started_at: trace.timestamp,
          status: trace.status,
          ok: trace.status >= 200 && trace.status < 400,
          duration_ms: trace.duration_us / 1000,
          trace_id: trace.trace_id,
          request_id: trace.request_id,
          provider: trace.selected_provider,
          route: `consumer-gateway → provider-gateway → ${trace.selected_provider} → backend`,
        });
        requestJob.completed += 1;
        requestJob.last_status = trace.status;
        if (trace.status >= 200 && trace.status < 400) requestJob.succeeded += 1;
        else requestJob.failed += 1;
        emitEvent('generation.progress', { job: requestJob });
        if (i < count - 1 && !requestJob.cancelled) await new Promise(resolve => setTimeout(resolve, requestJob.interval_ms));
      }
      requestJob.running = false;
      requestJob.finished_at = new Date().toISOString();
      emitEvent('generation.finished', { job: requestJob });
    })().catch(error => {
      requestJob.running = false;
      requestJob.error = error.message;
      requestJob.finished_at = new Date().toISOString();
    });
    return res.status(202).json({ job: requestJob });
  }

  if (dataSource === 'vcr') {
    try {
      const targetPool = req.body?.target_pool === 'pool-b' ? 'pool-b' : 'pool-a';
      const ip = await getVcrGatewayIp(targetPool);
      requestJob = {
        id: `llmd-${Date.now()}`,
        running: true,
        count,
        rate_per_second: rate,
        interval_ms: Math.round(1000 / rate),
        target_pool: targetPool,
        concurrency: Math.min(24, Math.max(1, Number.parseInt(req.body?.concurrency ?? 1, 10) || 1)),
        max_tokens: Math.min(256, Math.max(1, Number.parseInt(req.body?.max_tokens ?? 5, 10) || 5)),
        prompt,
        gateway_ip: ip,
        gateway_port: VCR_GATEWAY_PORT,
        completed: 0,
        succeeded: 0,
        failed: 0,
        last_status: null,
        results: [],
        started_at: new Date().toISOString(),
        finished_at: null,
        target: 'llmd-gateway',
      };
      runVcrRequestJob(requestJob, ip).catch((error) => {
        requestJob.running = false;
        requestJob.error = error.message;
        requestJob.finished_at = new Date().toISOString();
      });
      emitEvent('generation.started', { job: requestJob });
      return res.status(202).json({ job: requestJob });
    } catch (error) {
      return res.status(503).json({ error: `Unable to find the llm-d consumer gateway: ${error.message}` });
    }
  }

  if (dataSource !== 'glb') {
    return res.status(409).json({ error: 'Live request generation is not configured for this data source', reason: 'Select GLB or switch to Demo to generate safe simulated requests.' });
  }

  try {
    const ip = await getGlbGatewayIp();
    requestJob = {
      id: `glb-${Date.now()}`,
      running: true,
      count,
      rate_per_second: rate,
      interval_ms: Math.round(1000 / rate),
      prompt,
      gateway_ip: ip,
      completed: 0,
      succeeded: 0,
      failed: 0,
      last_status: null,
      results: [],
      started_at: new Date().toISOString(),
      finished_at: null,
      target: 'glb-gateway',
    };
    runRequestJob(requestJob, ip).catch((error) => {
      requestJob.running = false;
      requestJob.error = error.message;
      requestJob.finished_at = new Date().toISOString();
    });
    emitEvent('generation.started', { job: requestJob });
    return res.status(202).json({ job: requestJob });
  } catch (error) {
    return res.status(503).json({ error: `Unable to find the GLB gateway: ${error.message}` });
  }
});

app.post('/api/generate/cancel', (_req, res) => {
  if (requestJob?.running) requestJob.cancelled = true;
  res.json({ job: requestJob });
});

// ---------------------------------------------------------------------------
// Sustained llm-d load generator
// ---------------------------------------------------------------------------

app.get('/api/load/status', async (_req, res) => {
  if (dataSource !== 'vcr') {
    return res.json({ available: false, target: 'llmd-load', reason: 'Select the llm-d/EPP source to run sustained provider load.', job: loadJob });
  }
  const readiness = await getVcrReadiness();
  res.json({
    available: readiness.available,
    target: 'llmd-load',
    reason: readiness.available ? null : `llm-d consumer gateway unavailable: ${readiness.reason}`,
    job: loadJob,
  });
});

app.post('/api/load', async (req, res) => {
  if (dataSource !== 'vcr') {
    return res.status(409).json({ error: 'Sustained load is available only for the llm-d/EPP source.' });
  }
  if (loadJob?.running) {
    return res.status(409).json({ error: 'An llm-d load job is already running', job: loadJob });
  }
  const duration = Math.min(300, Math.max(5, Number.parseInt(req.body?.duration_seconds ?? 30, 10) || 30));
  const rate = Math.min(50, Math.max(0.1, Number(req.body?.rate ?? 5) || 5));
  const concurrency = Math.min(24, Math.max(1, Number.parseInt(req.body?.concurrency ?? 6, 10) || 6));
  const mode = req.body?.mode === 'sustained' ? 'sustained' : 'pulse';
  const targetPool = req.body?.target_pool === 'pool-b' ? 'pool-b' : 'pool-a';
  const maxTokens = Math.min(256, Math.max(1, Number.parseInt(req.body?.max_tokens ?? 32, 10) || 32));
  const prompt = typeof req.body?.prompt === 'string' && req.body.prompt.trim()
    ? req.body.prompt.trim().slice(0, 500)
    : 'dashboard sustained load';
  try {
    const ip = await getVcrGatewayIp(targetPool);
    loadJob = {
      id: `llmd-load-${Date.now()}`,
      running: true,
      target: 'llmd-load',
      target_pool: targetPool,
      mode,
      duration_seconds: duration,
      rate_per_second: rate,
      concurrency,
      max_tokens: maxTokens,
      prompt,
      gateway_ip: ip,
      gateway_port: VCR_GATEWAY_PORT,
      completed: 0,
      succeeded: 0,
      failed: 0,
      last_status: null,
      last_provider: null,
      last_consumer_gateway: null,
      providers: {},
      consumer_gateways: {},
      started_at: new Date().toISOString(),
      finished_at: null,
      stopped_reason: null,
    };
    runVcrLoadJob(loadJob, ip).catch(error => {
      loadJob.running = false;
      loadJob.error = error.message;
      loadJob.finished_at = new Date().toISOString();
      emitEvent('load.failed', { job: loadJob });
    });
    emitEvent('load.started', { job: loadJob });
    return res.status(202).json({ job: loadJob });
  } catch (error) {
    return res.status(503).json({ error: `Unable to find the llm-d consumer gateway for ${targetPool}: ${error.message}` });
  }
});

app.post('/api/load/cancel', (_req, res) => {
  if (loadJob?.running) loadJob.cancelled = true;
  res.json({ job: loadJob });
});

// ---------------------------------------------------------------------------
// Versioned request-centric contract
// ---------------------------------------------------------------------------

app.get('/api/v1/capabilities', async (_req, res) => {
  const jaegerReachable = await isJaegerReachable();
  const vcr = await loadLiveVcrState();
  const simulated = ALLOW_SIMULATION && (currentMode === 'demo' || (currentMode === 'auto' && !jaegerReachable));
  const live = !simulated;
  const glbReady = !simulated && dataSource === 'glb' ? await getGlbReadiness() : null;
  const vcrReady = !simulated && dataSource === 'vcr' ? await getVcrReadiness() : null;
  const generatorAvailable = simulated
    || (dataSource === 'glb' && glbReady?.available)
    || (dataSource === 'vcr' && vcrReady?.available);
  const generatorSource = simulated
    ? 'synthetic_generator'
    : dataSource === 'glb'
      ? 'glb_gateway'
      : dataSource === 'vcr' ? 'llmd_gateway' : 'none';
  const generatorReason = simulated
    ? 'Safe local simulation; no request leaves the browser host.'
    : dataSource === 'glb'
      ? glbReady?.available ? null : `GLB gateway unavailable: ${glbReady?.reason || 'target not found'}`
      : dataSource === 'combined'
        ? 'Combined-site live evidence is available, but no request generator is configured.'
        : vcrReady?.available ? null : `llm-d consumer gateway unavailable: ${vcrReady?.reason || 'target not found'}`;
  const state = (available, source, reason = null) => ({ state: available ? 'available' : 'unavailable', source, ...(reason ? { reason } : {}) });
  res.json({
    version: 'v1',
    features: {
      tokenRateLimit: TOKEN_RATE_LIMIT_ENABLED,
      fixtureMode: TOKEN_RATE_LIMIT_ENABLED ? TOKEN_RATE_LIMIT_FIXTURE_MODE : null,
      tokenRateLimitLive: TOKEN_RATE_LIMIT_LIVE,
      tokenRateLimitMultiQuota: TOKEN_RATE_LIMIT_LIVE && TOKEN_RATE_LIMIT_MULTI_QUOTA,
    },
    environment: {
      id: dataSource === 'vcr' ? 'grid-llmd-pool-metrics' : dataSource === 'combined' ? 'grid-combined-site' : 'grid-glb',
      display_name: dataSource === 'vcr' ? 'Grid llm-d pool metrics' : dataSource === 'combined' ? 'Grid combined site' : 'Grid GLB',
      profile: TOKEN_RATE_LIMIT_PROFILE
        ? 'token_rate_limit'
        : dataSource === 'vcr' ? 'llmd_pool' : dataSource === 'combined' ? 'combined_site' : 'glb',
      mode: simulated ? 'demo' : live && jaegerReachable ? 'live' : 'partial',
      detected_at: new Date().toISOString(),
    },
    capabilities: {
      can_generate_requests: state(Boolean(generatorAvailable), generatorSource, generatorReason),
      can_generate_load: state(Boolean(!simulated && dataSource === 'vcr' && vcrReady?.available), 'llmd_load_generator', dataSource === 'vcr' ? (vcrReady?.available ? null : generatorReason) : 'Sustained load is available only for the llm-d/EPP source.'),
      can_read_traces: state(jaegerReachable, 'jaeger', 'Jaeger is unreachable'),
      can_read_epp_metrics: state(Boolean(vcr), 'epp_prometheus', 'No live llm-d EPP state discovered'),
      can_read_overlay: state(Boolean(loadOverlayFromFile()) || Boolean(vcr), 'grid_overlay', 'No overlay source discovered'),
      can_replay_requests: state(simulated, 'synthetic_replay', simulated ? null : 'Only synthetic replay is enabled in this build.'),
      can_show_route_attribution: state(jaegerReachable || simulated, 'otel_span'),
    },
    semantics: { missing: '—', stale_metrics_are_not_zero: true, request_generation_is_always_visible: true },
  });
});

app.get('/api/v1/token-rate-limit', (req, res) => {
  if (!TOKEN_RATE_LIMIT_ENABLED) {
    return res.json({ version: 'v1', enabled: false, profile: 'token-rate-limit', data: null });
  }
  if (!TOKEN_RATE_LIMIT_FIXTURES) {
    if (TOKEN_RATE_LIMIT_LIVE) {
      return res.json({
        version: 'v1', enabled: true, fixture_mode: null, source: 'live',
        contract: TOKEN_RATE_LIMIT_CONTRACT, data: liveTokenRateLimitData(),
      });
    }
    return res.json({
      version: 'v1', enabled: true, profile: 'token-rate-limit', fixture_mode: null,
      data: null,
      warning: 'Token-rate-limit UI is enabled, but live consumer URLs and server-side credentials are not fully configured.',
    });
  }
  const allowedStates = new Set(['admitted', 'exhausted', 'concurrent-race', 'recovered']);
  const state = allowedStates.has(req.query.state) ? req.query.state : 'recovered';
  return res.json({ enabled: true, fixture_mode: TOKEN_RATE_LIMIT_FIXTURE_MODE, contract: TOKEN_RATE_LIMIT_CONTRACT, data: tokenRateLimitFixture(state) });
});

app.post('/api/v1/token-rate-limit/requests', async (req, res) => {
  if (!TOKEN_RATE_LIMIT_LIVE) {
    return res.status(409).json({ error: 'Live token-rate-limit request generation is not configured' });
  }
  const consumer = req.body?.consumer;
  if (consumer !== 'a' && consumer !== 'b') {
    return res.status(400).json({ error: 'consumer must be a or b' });
  }
  const appConfig = TOKEN_RATE_LIMIT_MULTI_QUOTA ? TOKEN_RATE_LIMIT_APPS.find(entry => entry.id === req.body?.app) : null;
  if (TOKEN_RATE_LIMIT_MULTI_QUOTA && !appConfig) return res.status(400).json({ error: 'app must identify one configured application' });
  try {
    const record = await createTokenRateLimitRecord(consumer, appConfig);
    return res.status(201).json({ version: 'v1', source: 'live', record, data: liveTokenRateLimitData() });
  } catch (error) {
    return res.status(502).json({ error: `Consumer Gateway ${consumer.toUpperCase()} request failed: ${error.message}` });
  }
});

app.delete('/api/v1/token-rate-limit/requests', (req, res) => {
  if (!TOKEN_RATE_LIMIT_LIVE) {
    return res.status(409).json({ error: 'Live token-rate-limit request generation is not configured' });
  }
  tokenRateLimitHistory.length = 0;
  return res.json({ version: 'v1', source: 'live', cleared: true, data: liveTokenRateLimitData() });
});

app.get('/api/v1/requests', async (req, res) => {
  const requestedLimit = Number.parseInt(req.query.limit || '50', 10);
  const limit = Math.min(100, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 50));
  const all = await normalizedRequestDataset();
  const jaegerReachable = await isJaegerReachable();
  const from = req.query.from ? Date.parse(req.query.from) : -Infinity;
  const to = req.query.to ? Date.parse(req.query.to) : Infinity;
  const provider = typeof req.query.provider === 'string' ? req.query.provider : null;
  const filtered = all.filter(request => {
    const timestamp = Date.parse(request.started_at || '') || 0;
    return timestamp >= from && timestamp <= to && (!provider || request.provider.name === provider || request.provider.cluster === provider);
  });
  const filterHash = JSON.stringify({ from: req.query.from || null, to: req.query.to || null, provider });
  const decoded = decodeCursor(req.query.cursor);
  if (!decoded) return res.status(400).json({ error: 'invalid cursor' });
  const offset = decoded.offset || 0;
  const items = filtered.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  res.json({
    version: 'v1', items, next_cursor: nextOffset < filtered.length ? encodeCursor(nextOffset, filterHash) : null,
    has_more: nextOffset < filtered.length,
    window: { from: req.query.from || null, to: req.query.to || null },
    partial: currentMode === 'demo' || !jaegerReachable,
    warnings: currentMode === 'demo' ? ['SIMULATED: request summaries are generated by the selected demo scenario.'] : [],
    page: { limit, offset, total_in_sample: filtered.length },
  });
});

app.get('/api/v1/requests/:requestId', async (req, res) => {
  const all = await normalizedRequestDataset();
  const request = all.find(item => item.request_id === req.params.requestId || item.trace_id === req.params.requestId);
  if (!request) return res.status(404).json({ error: 'request not found' });
  const simulated = effectiveDemoMode(await isJaegerReachable());
  res.json({ version: 'v1', request, replay: { allowed: simulated, tier: 'synthetic_only', reason: simulated ? null : 'Original request content is not replayable.' } });
});

app.get('/api/v1/requests/:requestId/trace', async (req, res) => {
  const all = await normalizedRequestDataset();
  const request = all.find(item => item.request_id === req.params.requestId || item.trace_id === req.params.requestId);
  if (!request) return res.status(404).json({ error: 'request not found' });
  if (request.trace_id && !request.trace_id.startsWith('000000000000000000000000000000')) {
    try {
      const result = await jaegerFetch(`/api/traces/${request.trace_id}`);
      if (result.status === 200 && result.body.data?.[0]) {
        const parsed = parseJaegerTrace(result.body.data[0]);
        return res.json({ version: 'v1', request_id: request.request_id, trace: parsed, quality: 'exact' });
      }
    } catch { /* fall through to the normalized summary */ }
  }
  res.json({ version: 'v1', request_id: request.request_id, trace: { trace_id: request.trace_id, spans: request.spans || [], span_count: request.span_count || 0 }, quality: request.trace_quality || 'simulated' });
});

app.get('/api/v1/replay/window', async (req, res) => {
  const all = await normalizedRequestDataset();
  const from = req.query.from ? Date.parse(req.query.from) : -Infinity;
  const to = req.query.to ? Date.parse(req.query.to) : Infinity;
  const requests = all.filter(request => {
    const at = Date.parse(request.started_at || '') || 0;
    return at >= from && at <= to;
  });
  const events = requests.map((request, index) => ({
    id: `request-${request.request_id}`,
    type: request.routing?.failover ? 'route.changed' : index === 0 ? 'baseline' : 'request.observed',
    at: request.started_at,
    label: request.routing?.failover ? `Failover to ${request.provider?.name || 'provider'}` : `${request.status || 'unknown'} request observed`,
    quality: request.trace_quality || 'simulated',
    request_id: request.request_id,
  }));
  res.json({ version: 'v1', cursor_time: req.query.cursor || (requests[0]?.started_at || null), window: { from: req.query.from || null, to: req.query.to || null }, requests, events, reconstruction: { mode: 'visual', network_traffic: false, quality: currentMode === 'demo' ? 'simulated' : 'sampled', note: 'This view reconstructs observed evidence; it does not replay network traffic.' } });
});

app.get('/api/v1/events/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`event: ready\ndata: ${JSON.stringify({ type: 'ready', time: new Date().toISOString() })}\n\n`);
  eventClients.add(res);
  req.on('close', () => eventClients.delete(res));
});

app.post('/api/v1/replays', async (req, res) => {
  const simulated = effectiveDemoMode(await isJaegerReachable());
  if (!simulated) return res.status(403).json({ error: 'Replay is disabled', reason: 'Only synthetic demo replay is enabled.' });
  const requestId = req.body?.request_id;
  const all = await normalizedRequestDataset();
  const original = all.find(item => item.request_id === requestId);
  if (!original) return res.status(404).json({ error: 'request not found' });
  const id = `replay-${Date.now().toString(36)}`;
  const replay = { id, request_id: requestId, status: 'queued', tier: 'synthetic_only', created_at: new Date().toISOString(), actor: 'dashboard' };
  replayJobs.set(id, replay);
  emitEvent('replay.progress', { replay });
  setTimeout(() => { replay.status = 'completed'; replay.completed_at = new Date().toISOString(); emitEvent('replay.completed', { replay }); }, 250);
  res.status(202).json({ replay });
});

app.get('/api/v1/replays/:replayId', (req, res) => {
  const replay = replayJobs.get(req.params.replayId);
  if (!replay) return res.status(404).json({ error: 'replay not found' });
  res.json({ replay });
});

app.get('/api/attribution', async (_req, res) => {
  const jaegerUp = await isJaegerReachable();
  if (!jaegerUp) return res.json({ available: false, sample_size: 0, providers: {} });
  const allTraces = filterRecentTraces(await fetchLiveTracesAllServices(100));
  const praxisTraces = allTraces.filter(trace => trace.source === 'praxis' && trace.demo_run_id);
  const currentRunId = praxisTraces.map(trace => trace.demo_run_id).sort().at(-1) || null;
  const traces = currentRunId
    ? praxisTraces.filter(trace => trace.demo_run_id === currentRunId)
    : allTraces.filter(trace => trace.source === 'praxis');
  const providers = {};
  for (const trace of traces) {
    const provider = trace.selected_cluster;
    if (provider && provider !== 'unknown') providers[provider] = (providers[provider] || 0) + 1;
  }
  res.json({ available: true, run_id: currentRunId, sample_size: traces.length, providers });
});

// ---------------------------------------------------------------------------
// VCR evidence loader
// ---------------------------------------------------------------------------

async function kubectlRaw(context, path) {
  const { stdout } = await execFileAsync('kubectl', [
    '--context', context,
    'get', '--raw', path,
  ], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

async function kubectlConfigMap(context) {
  const { stdout } = await execFileAsync('kubectl', [
    '--context', context,
    '-n', VCR_NAMESPACE,
    'get', 'configmap', VCR_OVERLAY_CONFIGMAP,
    '-o', 'json',
  ], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function parsePrometheusGauge(metrics, metricName, poolName) {
  const line = metrics.split('\n').find(candidate =>
    candidate.startsWith(`${metricName}{`) && candidate.includes(`name="${poolName}"`));
  if (!line) return null;
  const value = Number.parseFloat(line.slice(line.lastIndexOf('}') + 1).trim());
  return Number.isFinite(value) ? value : null;
}

async function loadLiveVcrState(perspectivePool = 'pool-a') {
  if (!VCR_LIVE_ENABLED) return null;
  const perspectiveKey = perspectivePool === 'pool-b' ? 'pool-b' : 'pool-a';
  if (liveVcrCache.expires > Date.now() && liveVcrCache.key === perspectiveKey) return liveVcrCache.value;

  try {
    const pools = [];
    for (const context of VCR_CONTEXTS) {
      const [metrics, configMap] = await Promise.all([
        kubectlRaw(context, `/api/v1/namespaces/${VCR_NAMESPACE}/services/http:llmd-epp-metrics:9090/proxy/metrics`),
        kubectlConfigMap(context),
      ]);
      const overlayData = configMap.data['routing-overlay.json']
        || configMap.data['routing-config.json'];
      if (!overlayData) {
        throw new Error(`overlay ConfigMap ${VCR_OVERLAY_CONFIGMAP} has no routing overlay data`);
      }
      const overlay = JSON.parse(overlayData);
      pools.push({ context, metrics, overlay });
    }

    const primary = pools[perspectiveKey === 'pool-b' ? 1 : 0];
    // Current Grid overlay ConfigMaps use a top-level candidates array;
    // earlier experimental snapshots nested it under overlay. Accept both
    // schemas while preserving the live values exactly as published.
    const candidates = primary.overlay?.candidates
      || primary.overlay?.overlay?.candidates
      || [];
    const metricsByPool = new Map();
    for (const { metrics } of pools) {
      const queue = metrics.match(/inference_pool_average_queue_size\{name="([^"]+)"\}\s+([\d.eE+-]+)/);
      const kv = metrics.match(/inference_pool_average_kv_cache_utilization\{name="([^"]+)"\}\s+([\d.eE+-]+)/);
      if (queue) metricsByPool.set(queue[1], {
        queue: Number.parseFloat(queue[2]),
        kv: kv && kv[1] === queue[1] ? Number.parseFloat(kv[2]) : null,
      });
    }

    const providers = candidates.map(candidate => {
      const signal = metricsByPool.get(candidate.site);
      const queue = signal?.queue ?? null;
      const kv = signal?.kv ?? null;
      const queueRatio = queue === null
        ? null
        : Math.min(1, Math.max(0, queue / VCR_QUEUE_CAPACITY));
      return {
        name: candidate.name,
        cluster: candidate.cluster,
        site: candidate.site,
        stable_id: candidate.stable_id,
        admission_state: candidate.admission_state,
        selection_tier: candidate.selection_tier,
        healthy: candidate.fresh !== false,
        score: typeof candidate.score === 'number' ? candidate.score : null,
        rank: typeof candidate.rank === 'number' ? candidate.rank : null,
        score_breakdown: candidate.score_breakdown || null,
        queue_depth: queueRatio === null ? null : {
          value: queueRatio,
          raw_value: queue,
          capacity: VCR_QUEUE_CAPACITY,
          unit: 'normalized_ratio',
          source: 'inference_pool_average_queue_size',
          fresh: true,
        },
        kv_cache: kv === null ? null : {
          value: kv,
          unit: 'ratio',
          source: 'inference_pool_average_kv_cache_utilization',
          fresh: true,
        },
        ...classifyProvider({ queue_depth: queueRatio, kv_cache: kv }),
      };
    });
    const value = {
      mode: 'live',
      source: 'vcr-epp-live',
      scoring_strategy: 'queueDepth',
      providers,
      overlay_revision: primary.overlay?.revision?.value
        || primary.overlay?.revision
        || primary.overlay?.overlay?.revision?.value
        || null,
      generated_at: primary.overlay?.generated_at
        || primary.overlay?.overlay?.generated_at
        || null,
      contexts: VCR_CONTEXTS,
    };
    liveVcrCache = { expires: Date.now() + 2000, key: perspectiveKey, value };
    return value;
  } catch (error) {
    console.error(`Live llm-d/EPP state unavailable: ${error.message}`);
    liveVcrCache = { expires: Date.now() + 2000, key: perspectiveKey, value: null };
    return null;
  }
}

function loadVcrEvidence() {
  if (!VCR_EVIDENCE_DIR || !existsSync(VCR_EVIDENCE_DIR)) return null;
  try {
    const dirs = readdirSync(VCR_EVIDENCE_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort()
      .reverse();
    if (dirs.length === 0) return null;
    const latest = dirs[0];
    const evidencePath = join(VCR_EVIDENCE_DIR, latest, 'evidence.json');
    if (!existsSync(evidencePath)) return null;
    const data = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    data._evidence_dir = latest;
    return data;
  } catch {
    return null;
  }
}

function vcrProvidersFromEvidence(evidence) {
  if (!evidence?.proofs) return [];
  const providerMap = new Map();
  const pattern = /(pool-\w+):\s+queue=([\d.]+(?:\/\d+)?)\s+kv=([\d.]+)\s+score=([\d.]+)\s+rank=(\d+)/;
  const simplePattern = /(?:^|\s)(pool-\w+)\s+queue=([\d.]+(?:\/\d+)?)\s+kv=([\d.]+)\s+score=([\d.]+)\s+rank=(\d+)/;

  for (const [, proof] of Object.entries(evidence.proofs)) {
    if (!proof?.success) continue;
    for (const line of (proof.observations || [])) {
      const match = line.match(pattern) || line.match(simplePattern);
      if (match) {
        const [, name, queueRaw, kv, score, rank] = match;
        const queueVal = parseFloat(queueRaw.split('/')[0]);
        const kvVal = parseFloat(kv);
        providerMap.set(name, {
          name: `llmd-${name}-provider`,
          cluster: name,
          site: name,
          stable_id: name,
          admission_state: 'new_and_existing',
          selection_tier: name === 'pool-a' ? 'same_region' : 'cross_region',
          healthy: true,
          score: parseFloat(score),
          rank: parseInt(rank, 10),
          queue_depth: {
            value: queueVal,
            unit: 'normalized_ratio',
            source: 'llm_d_router_epp_average_queue_size',
            fresh: true,
          },
          kv_cache: {
            value: kvVal,
            unit: 'ratio',
            source: 'llm_d_router_epp_average_kv_cache_utilization',
            fresh: true,
          },
          ...classifyProvider({ queue_depth: queueVal, kv_cache: kvVal }),
          score_breakdown: null,
        });
      }
    }
  }
  return [...providerMap.values()];
}

function vcrTimelineFromEvidence(evidence) {
  if (!evidence?.proofs) return [];
  const events = [];
  const proofs = evidence.proofs;

  if (proofs.baseline?.success) {
    const obs = proofs.baseline.observations || [];
    const attrLine = obs.find(l => l.includes('attribution:'));
    events.push({
      time: '00:00',
      type: 'baseline',
      label: 'Baseline: pool-a preferred',
      detail: attrLine || proofs.baseline.description,
      severity: 'info',
    });
  }

  if (proofs.pressure_and_flip?.success) {
    const obs = proofs.pressure_and_flip.observations || [];
    const flipLine = obs.find(l => l.includes('flip:'));
    const loadLine = obs.find(l => l.includes('load stats:'));
    events.push({
      time: '00:12',
      type: 'load_started',
      label: 'Pressure generator started',
      detail: obs.find(l => l.includes('replicas')) || 'Gateway-routed load',
      severity: 'info',
    });
    if (flipLine) {
      events.push({
        time: '00:20',
        type: 'route_change',
        label: 'Route changed: pool-a → pool-b',
        detail: flipLine,
        severity: 'warning',
      });
    }
    if (loadLine) {
      events.push({
        time: '00:25',
        type: 'attribution',
        label: 'Traffic attribution',
        detail: loadLine,
        severity: 'info',
      });
    }
  }

  if (proofs.recovery?.success) {
    const obs = proofs.recovery.observations || [];
    const recLine = obs.find(l => l.includes('recovery:'));
    events.push({
      time: '01:00',
      type: 'load_stopped',
      label: 'Pressure stopped',
      detail: obs.find(l => l.includes('scaled to 0')) || 'Generator stopped',
      severity: 'info',
    });
    if (recLine) {
      events.push({
        time: '01:15',
        type: 'baseline',
        label: 'pool-a restored as preferred',
        detail: recLine,
        severity: 'info',
      });
    }
  }

  return events;
}

app.get('/api/causal', async (_req, res) => {
  const jaegerUp = await isJaegerReachable();
  const effectiveMode = currentMode === 'auto' ? (jaegerUp ? 'live' : ALLOW_SIMULATION ? 'demo' : 'unavailable') : currentMode;

  let providers = [];
  let strategy = 'unknown';
  let route = null;
  let timeline = [];

  if (dataSource === 'vcr' || dataSource === 'combined') {
    const evidence = loadVcrEvidence();
    if (evidence) {
      providers = vcrProvidersFromEvidence(evidence);
      strategy = 'queueDepth';
      timeline = vcrTimelineFromEvidence(evidence);
      const ranked = [...providers].sort((a, b) => (b.score || 0) - (a.score || 0));
      if (ranked.length) {
        route = {
          selected: ranked[0].cluster,
          decision: `scored ${ranked.length} backends, selected ${ranked[0].cluster} (score=${ranked[0].score?.toFixed(2)})`,
          policy: 'scoreFirst',
        };
      }
    }
  }

  if (dataSource === 'glb' || (dataSource === 'combined' && !providers.length)) {
    if (effectiveMode === 'live' && jaegerUp) {
      const liveState = await fetchLivePoolState();
      if (liveState) {
        providers = liveState.pools.map(p => ({ ...p, ...classifyProvider(p) }));
        strategy = liveState.scoring_strategy;
        route = liveState.latest_trace ? {
          selected: liveState.latest_trace.selected_cluster,
          decision: liveState.latest_trace.routing_decision,
          policy: liveState.latest_trace.routing_policy,
        } : null;
        timeline = buildTimelineFromTraces(await fetchLiveTracesAllServices(50));
      }
    } else if (effectiveMode === 'demo' && ALLOW_SIMULATION) {
      const scenario = DEMO_SCENARIOS[demoScenario] || DEMO_SCENARIOS.baseline;
      const scored = scoreAndRankPools(scenario.pools);
      providers = scored.map(p => ({ ...p, ...classifyProvider(p) }));
      strategy = 'demo';
      route = {
        selected: scored.find(p => p.healthy)?.name || scored[0]?.name,
        decision: `demo scenario: ${demoScenario}`,
        policy: 'scoreFirst',
      };
      timeline = buildDemoTimeline();
    }
  }

  if (effectiveMode === 'unavailable' && !providers.length) {
    return res.json({ mode: 'unavailable', warning: 'No live metrics or trace source is available; simulation is disabled.', steps: { traffic: { state: 'unavailable' }, metrics: { state: 'unavailable' }, score: { state: 'unavailable' }, route: { state: 'unavailable' }, attribution: { state: 'unavailable' } } });
  }

  const hasRouteChange = timeline.some(e => e.type === 'route_change');
  const routeEvent = timeline.find(e => e.type === 'route_change');
  const attrEvent = timeline.find(e => e.type === 'attribution');

  const selectedProvider = providers.find(p => (p.cluster || p.name) === route?.selected) || providers[0];
  const maxPressure = providers.reduce((max, p) => {
    const v = p.pressure_value ?? (typeof p.queue_depth === 'number' ? p.queue_depth : null);
    return v !== null && v > (max ?? -1) ? v : max;
  }, null);

  const steps = {
    traffic: {
      state: hasRouteChange ? 'changed' : 'steady',
      provider_count: providers.length,
      detail: hasRouteChange ? (routeEvent?.label || 'Route changed') : 'Steady state',
    },
    metrics: {
      per_provider: providers.map(p => ({
        name: p.cluster || p.name,
        queue_depth: typeof p.queue_depth === 'number' ? p.queue_depth : p.queue_depth?.value ?? null,
        kv_cache: typeof p.kv_cache === 'number' ? p.kv_cache : p.kv_cache?.value ?? null,
        pressure_level: p.pressure_level || 'unknown',
      })),
      max_pressure: maxPressure,
      max_level: selectedProvider?.pressure_level || 'unknown',
    },
    score: {
      strategy,
      weights: { locality: 3.0, queue_depth: 5.0 },
      per_provider: providers.map(p => ({
        name: p.cluster || p.name,
        score: p.score ?? null,
        rank: p.rank ?? null,
      })),
    },
    route: route,
    attribution: attrEvent ? { detail: attrEvent.detail, label: attrEvent.label } : null,
  };

  let narrative = '';
  if (hasRouteChange) {
    narrative = `Route changed due to pressure. ${routeEvent?.label || ''}. `;
  } else {
    narrative = `${route?.selected || 'unknown'} is the preferred provider. `;
  }
  narrative += `Scoring strategy: ${strategy}. `;
  if (strategy === 'noMetrics') narrative += 'All scores are 0.0 — routing by locality tier only.';

  res.json({ data_source: dataSource, mode: effectiveMode, steps, narrative });
});

app.get('/api/timing', (_req, res) => {
  res.json({
    operator: {
      reconcile_interval_secs: 300,
      tls_reconcile_interval_secs: 60,
      metrics_scrape_timeout_secs: 5,
      stale_metrics_secs: 20,
      description: 'Operator reconciles GridNetwork every 300s (60s with TLS metrics). Each reconcile scrapes provider metrics, recalculates scores, and publishes overlay ConfigMap.',
      classification: 'source-derived',
    },
    overlay_sync: {
      delivery: 'k8s_configmap_watch',
      latency: 'event-driven (sub-second after ConfigMap update)',
      reconnect_backoff_max_secs: 30,
      description: 'overlay-sync watches the ConfigMap and pushes updates to the gateway immediately on change.',
      classification: 'source-derived',
    },
    scoring: {
      filter_execution_us: 27,
      filter_execution_label: 'routing.select span duration (filter execution, not end-to-end request latency)',
      strategy_options: ['noMetrics', 'queueDepth', 'kvCachePressure'],
      weights: { locality: 3.0, queue_depth: 5.0 },
      description: 'Score recalculation happens during each operator reconcile. The routing.select span measures filter execution time only.',
      classification: 'runtime-tested',
    },
    tracing: {
      span_injection: 'W3C TraceContext (traceparent/tracestate)',
      collector_protocol: 'OTLP/HTTP (port 4318)',
      exporter: 'opentelemetry-otlp 0.29',
      spans_per_request: 6,
      services_per_trace: 3,
      classification: 'runtime-tested',
    },
    epp_metrics: {
      scrape_endpoint: 'http://llmd-epp-metrics.grid-system.svc.cluster.local:9090/metrics',
      signal_names: {
        queue_depth: 'inference_pool_average_queue_size',
        kv_cache: 'inference_pool_average_kv_cache_utilization',
        healthy_pods: 'inference_pool_ready_pods',
      },
      queue_capacity: 4,
      stale_threshold_secs: 20,
      scrape_timeout_secs: 2,
      classification: 'source-derived',
    },
    vcr_demo: {
      wall_secs: 298.8,
      metrics_transport: 'direct-http',
      proofs: 4,
      model: 'Qwen/Qwen3-0.6B',
      provider_kind: 'vllm-vcr',
      description: 'VCR demo runs baseline → pressure → provenance → recovery in ~5 minutes.',
      classification: 'runtime-tested',
    },
  });
});

app.get('/api/vcr/status', async (_req, res) => {
  const live = await loadLiveVcrState();
  if (live) {
    return res.json({
      available: true,
      mode: 'live',
      source: 'vcr-epp-live',
      scoring_strategy: live.scoring_strategy,
      overlay_revision: live.overlay_revision,
      generated_at: live.generated_at,
      contexts: live.contexts,
    });
  }
  const evidence = loadVcrEvidence();
  if (!evidence) {
    return res.json({ available: false, mode: 'unavailable' });
  }
  res.json({
    available: true,
    mode: evidence.success ? 'replay' : 'failed',
    started_at: evidence.started_at,
    wall_secs: evidence.wall_secs,
    metrics_transport: evidence.metrics_transport,
    evidence_run: evidence._evidence_dir,
    images: evidence.setup?.images || null,
    scoring_strategy: 'queueDepth',
  });
});

app.get('/api/vcr/providers', async (req, res) => {
  const live = await loadLiveVcrState(req.query.target_pool);
  if (live) return res.json(live);
  const evidence = loadVcrEvidence();
  if (!evidence) {
    return res.json({ mode: 'unavailable', source: 'vcr', providers: [] });
  }
  const providers = vcrProvidersFromEvidence(evidence);
  res.json({
    mode: 'replay',
    source: 'vcr-epp',
    scoring_strategy: 'queueDepth',
    providers,
    evidence_run: evidence._evidence_dir,
    started_at: evidence.started_at,
  });
});

app.get('/api/vcr/timeline', async (req, res) => {
  const live = await loadLiveVcrState(req.query.target_pool);
  if (live) {
    const selected = live.providers.find(provider => provider.rank === 0) || live.providers[0];
    const metrics = live.providers.map(provider => {
      const queue = provider.queue_depth?.value;
      const rawQueue = provider.queue_depth?.raw_value;
      const kv = provider.kv_cache?.value;
      const queueText = typeof queue === 'number'
        ? `${typeof rawQueue === 'number' ? rawQueue.toFixed(1) : '—'} requests (${queue.toFixed(2)} normalized)`
        : '—';
      return `${provider.site}: queue=${queueText}, KV=${typeof kv === 'number' ? kv.toFixed(2) : '—'}, score=${typeof provider.score === 'number' ? provider.score.toFixed(2) : '—'}, rank=${provider.rank ?? '—'}`;
    }).join('; ');
    return res.json({
      mode: 'live',
      source: 'vcr-epp-live',
      events: [{
        time: live.generated_at || new Date().toISOString(),
        type: 'live_metrics',
        label: `Live EPP metrics: ${selected?.site || 'no selected provider'} rank 0`,
        detail: metrics,
        severity: 'info',
      }],
    });
  }
  const evidence = loadVcrEvidence();
  if (!evidence) {
    return res.json({ mode: 'unavailable', source: 'vcr', events: [] });
  }
  const events = vcrTimelineFromEvidence(evidence);
  res.json({ mode: 'replay', source: 'vcr-epp', events });
});

// ---------------------------------------------------------------------------
// Cloud-burst live status + load control (reads the running kind/OpenShift
// deployment via kubectl). Env-gated so other profiles are unaffected.
// ---------------------------------------------------------------------------
const CB_CONTEXT = process.env.TRACING_UI_CB_CONTEXT || null;
const CB_NS = process.env.TRACING_UI_CB_NAMESPACE || 'grid-system';
const CB_OVERLAY_CM = process.env.TRACING_UI_CB_OVERLAY_CONFIGMAP
  || 'grid-overlay-grid-token-rate-limit-consumer-gateway-a';
const CB_CONSUMER_CONFIGS = {
  a: process.env.TRACING_UI_CB_CONSUMER_A_CONFIGMAP || 'consumer-gateway-a-config',
  b: process.env.TRACING_UI_CB_CONSUMER_B_CONFIGMAP || 'consumer-gateway-b-config',
};
const CB_DEFAULT_ALLOCATIONS = { alice: 60, bob: 5000, default: 5000 };
const CB_QUEUE_METRIC = process.env.TRACING_UI_CB_QUEUE_METRIC || 'inference_pool_average_queue_size';
const CB_EXTERNAL_TARGET = process.env.TRACING_UI_CB_EXTERNAL_TARGET || 'api.openai.com';
const CB_LOAD_DEPLOY = process.env.TRACING_UI_CB_LOAD_DEPLOY || 'epp-load';
const CB_NETWORK = process.env.TRACING_UI_CB_NETWORK || 'grid-token-rate-limit';
const CB_LOCAL_PROVIDER_NAMES = (process.env.TRACING_UI_CB_LOCAL_PROVIDERS || 'static-a,static-b,static-c').split(',').map(value => value.trim()).filter(Boolean);
const CB_SIM_PROVIDER_NAMES = (process.env.TRACING_UI_CB_SIM_PROVIDERS || 'static-sim-a,static-sim-b,static-sim-c').split(',').map(value => value.trim()).filter(Boolean);
const CB_LOCAL_PROVIDER_KEYS = CB_LOCAL_PROVIDER_NAMES.map((_, index) => String.fromCharCode(97 + index));
const CB_LOCAL_PROVIDER_INDEX = new Map(CB_LOCAL_PROVIDER_NAMES.map((name, index) => [name, index]));
const CB_CONSUMER_DEPLOYS = {
  a: process.env.TRACING_UI_CB_CONSUMER_A_DEPLOY || 'consumer-gateway-a',
  b: process.env.TRACING_UI_CB_CONSUMER_B_DEPLOY || 'consumer-gateway-b',
};
const CB_GPU_METRIC_TARGETS = (process.env.TRACING_UI_CB_GPU_METRIC_TARGETS
  || 'east=rhoai-qwen3b-east-predictor.grid-cloud-burst-rhoai.svc.cluster.local:8080,west=rhoai-qwen3b-west-predictor.grid-cloud-burst-rhoai.svc.cluster.local:8080')
  .split(',').map(value => value.trim()).filter(Boolean).map(value => {
    const [provider, target] = value.split('=');
    return { provider, target };
  });

// Backend-sensitivity presets. "sim" is the kind mock (llm-d-inference-sim) with
// a deep waiting queue, so it needs heavy load to saturate. "gpu" mirrors a real
// vLLM pool that saturates and flips admission at a much smaller queue, so it
// bursts on far less pressure. The dropdown on the load generator picks the mode;
// each preset sets BOTH the gauge capacity (visualization) and the generator
// replica count (how much load "Simulate load" applies). For a real GPU deploy,
// set Grid's scoring capacity to match TRACING_UI_CB_QUEUE_CAPACITY_GPU so the
// actual admission flip lines up with the gauge.
const CB_QUEUE_CAPACITY = Number.parseInt(process.env.TRACING_UI_CB_QUEUE_CAPACITY || '8', 10);
const CB_QUEUE_CAPACITY_GPU = Number.parseInt(process.env.TRACING_UI_CB_QUEUE_CAPACITY_GPU || '2', 10);
const CB_LOAD_REPLICAS = process.env.TRACING_UI_CB_LOAD_REPLICAS || '3';
const CB_LOAD_REPLICAS_GPU = process.env.TRACING_UI_CB_LOAD_REPLICAS_GPU || '1';
const CB_DEFAULT_MODE = (process.env.TRACING_UI_CB_MODE || 'sim').toLowerCase() === 'gpu' ? 'gpu' : 'sim';
const CB_PRICING_REVISION = process.env.TRACING_UI_CB_PRICING_REVISION || 'demo-pricing-unverified';
const CB_PRICING_MODEL = process.env.TRACING_UI_CB_PRICING_MODEL || 'gpt-4o-mini';
const CB_INPUT_MICROS_PER_MILLION = Number.parseInt(process.env.TRACING_UI_CB_PRICING_INPUT_MICROS || '150000', 10);
const CB_OUTPUT_MICROS_PER_MILLION = Number.parseInt(process.env.TRACING_UI_CB_PRICING_OUTPUT_MICROS || '600000', 10);
const CB_CACHED_INPUT_MICROS_PER_MILLION = Number.parseInt(process.env.TRACING_UI_CB_PRICING_CACHED_INPUT_MICROS || '75000', 10);
const CB_CONTROL_SCRIPT = process.env.TRACING_UI_CB_CONTROL_SCRIPT || null;
const CB_CONTROL_TIMEOUT = 15000;
const CB_LOGICAL_MODEL = process.env.TRACING_UI_CB_MODEL || 'gpt-4o-mini';
const CB_TRAFFIC_PRINCIPAL = process.env.TRACING_UI_CB_PRINCIPAL || TOKEN_RATE_LIMIT_USERNAME;
const CB_TRAFFIC_PASSWORD = process.env.TRACING_UI_CB_PASSWORD || TOKEN_RATE_LIMIT_PASSWORD;
const CB_TRAFFIC_LIMIT = Math.min(1000, Math.max(1, Number.parseInt(process.env.TRACING_UI_CB_TRAFFIC_LIMIT || '100', 10)));
const CB_MODES = {
  sim: { label: 'Simulation (kind)', capacity: CB_QUEUE_CAPACITY, replicas: Number.parseInt(CB_LOAD_REPLICAS, 10) },
  gpu: { label: 'Real GPU', capacity: CB_QUEUE_CAPACITY_GPU, replicas: Number.parseInt(CB_LOAD_REPLICAS_GPU, 10) },
};
const cbMode = (m) => (m === 'gpu' || m === 'sim' ? m : CB_DEFAULT_MODE);
let cbCostCache = { expires: 0, value: null, pending: null };
const cloudBurstTrafficHistory = [];
let cloudBurstTrafficSequence = 0;
let cloudBurstPressureJob = null;
const cloudBurstControlState = {
  metrics: Object.fromEntries(CB_LOCAL_PROVIDER_KEYS.map(key => [key, 0])),
  health: Object.fromEntries(CB_LOCAL_PROVIDER_KEYS.map(key => [key, 'healthy'])),
  disabled: Object.fromEntries(CB_LOCAL_PROVIDER_KEYS.map(key => [key, false])),
  weights: Object.fromEntries(CB_LOCAL_PROVIDER_KEYS.map((key, index) => [key, [50, 30, 20][index] || 1])),
  overflow_weights: { openai: 25, bedrock: 75 },
  overflow_health: { openai: 'healthy', bedrock: 'healthy' },
  allocation: { principal: CB_TRAFFIC_PRINCIPAL, limit: null, enforcement: 'soft', revision: 0 },
  last_action: null,
};

function cbNumeric(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function cbHttpText(target, path, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const url = new URL(`http://${target}${path}`);
    const request = http.get({ hostname: url.hostname, port: url.port, path: url.pathname, timeout }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => response.statusCode === 200 ? resolve(body) : reject(new Error(`metrics returned ${response.statusCode}`)));
    });
    request.on('timeout', () => request.destroy(new Error('metrics request timed out')));
    request.on('error', reject);
  });
}

async function cbReadGpuMetrics() {
  const values = [];
  for (const target of CB_GPU_METRIC_TARGETS) {
    try {
      const body = await cbHttpText(target.target, '/metrics');
      const read = (name) => {
        const line = body.split('\n').find(item => item.startsWith(`${name}{`) || item.startsWith(`${name} `));
        return line ? Number.parseFloat(line.trim().split(/\s+/).pop()) : null;
      };
      values.push({ provider: target.provider, waiting: read('vllm:num_requests_waiting'), running: read('vllm:num_requests_running'), kv_cache: read('vllm:kv_cache_usage_perc') });
    } catch { values.push({ provider: target.provider, waiting: null, running: null, kv_cache: null }); }
  }
  return values;
}

function cbSpanNumber(request, names) {
  for (const span of request?.spans || []) {
    for (const tag of span.tags || []) {
      if (names.includes(tag.key)) {
        const value = cbNumeric(tag.value);
        if (value !== null) return value;
      }
    }
  }
  return null;
}

function cbCloudProvider(provider) {
  return /openai|cloud|external/i.test(String(provider || ''));
}

function cbCloudProviderName(provider) {
  const value = String(provider || '').toLowerCase();
  if (value.includes('bedrock')) return 'bedrock';
  if (value.includes('openai')) return 'openai';
  return value.includes('cloud') || value.includes('external') ? 'cloud' : null;
}

const CB_OPENAI_PROVIDERS = ['static-openai-a', 'static-openai-b', 'static-openai-c'];

function cbOverflowOpenAiWeights(total) {
  // Keep the three egress paths in the same 8/8/9 relative split used by the
  // topology while exposing one aggregate OpenAI overflow weight to the UI.
  if (!Number.isInteger(total) || total < CB_OPENAI_PROVIDERS.length) return null;
  const first = Math.max(1, Math.round(total * 8 / 25));
  const second = Math.max(1, Math.round(total * 8 / 25));
  const third = total - first - second;
  return third >= 1 ? [first, second, third] : null;
}

async function cbPatchOverflowWeights(openai, bedrock) {
  const openaiWeights = cbOverflowOpenAiWeights(openai);
  if (!openaiWeights) throw new Error('OpenAI overflow weight must be at least 3 for three egress paths');
  for (const [index, name] of CB_OPENAI_PROVIDERS.entries()) {
    await cbKubectl(['patch', 'inferenceprovider', name, '--type=merge', '-p', JSON.stringify({ spec: { capacityWeight: openaiWeights[index] } })]);
  }
  const bedrockProvider = process.env.TRACING_UI_CB_BEDROCK_PROVIDER || 'static-bedrock';
  await cbKubectl(['patch', 'inferenceprovider', bedrockProvider, '--type=merge', '-p', JSON.stringify({ spec: { capacityWeight: bedrock } })]);
}

async function cbPatchOverflowHealth(provider, state) {
  const path = state === 'healthy' ? '/health' : '/__cloud_burst_unhealthy__';
  const names = provider === 'bedrock'
    ? [process.env.TRACING_UI_CB_BEDROCK_PROVIDER || 'static-bedrock']
    : CB_OPENAI_PROVIDERS;
  for (const name of names) {
    await cbKubectl(['patch', 'inferenceprovider', name, '--type=merge', '-p', JSON.stringify({ spec: { healthCheck: { path } } })]);
  }
}

async function readCloudBurstCost() {
  if (!TOKEN_CLOUD_BURST || !CB_CONTEXT) return { enabled: false };
  const now = Date.now();
  if (cbCostCache.value && cbCostCache.expires > now) return cbCostCache.value;
  if (cbCostCache.pending) return cbCostCache.pending;
  cbCostCache.pending = (async () => {
    let requests = [];
    try {
      requests = (await normalizedRequestDataset()).slice(0, 200);
    } catch {
      // The cost view remains explicit about unavailable telemetry.
    }
    requests = [...cloudBurstTrafficHistory.map(item => ({
      started_at: item.at,
      provider: item.provider,
      cloud: item.cloud,
      trace_id: item.trace_id,
      input_tokens: item.input_tokens,
      output_tokens: item.output_tokens,
      total_tokens: item.total_tokens,
      status: item.status,
    })), ...requests];
    const observed = requests.map(request => {
      const provider = request.provider || request.selected_provider || request.selected_site || null;
      const input = cbNumeric(request.input_tokens) ?? cbSpanNumber(request, ['usage.input_tokens', 'tokens.input', 'gen_ai.usage.input_tokens']);
      const output = cbNumeric(request.output_tokens) ?? cbSpanNumber(request, ['usage.output_tokens', 'tokens.output', 'gen_ai.usage.output_tokens']);
      const total = cbNumeric(request.total_tokens);
      return {
        at: request.started_at || request.timestamp || null,
        provider,
        cloud: request.cloud === true || cbCloudProvider(provider),
        trace_id: request.trace_id || request.trace?.trace_id || null,
        input_tokens: input ?? (request.cloud === true ? null : total),
        output_tokens: output ?? (request.cloud === true ? null : 0),
        status: request.status || request.http?.status || null,
        estimated: input === null || output === null,
      };
    }).filter(item => item.at);
    const withUsage = observed.filter(item => item.input_tokens !== null && item.output_tokens !== null);
    const sum = (items, field) => items.reduce((total, item) => total + (item[field] || 0), 0);
    const cloud = withUsage.filter(item => item.cloud);
    const local = withUsage.filter(item => !item.cloud);
    const costMicros = items => sum(items, 'input_tokens') * CB_INPUT_MICROS_PER_MILLION / 1e6
      + sum(items, 'output_tokens') * CB_OUTPUT_MICROS_PER_MILLION / 1e6;
    const actualCost = costMicros(cloud);
    const allCloudCost = costMicros([...cloud, ...local]);
    const first = Date.now() - 60 * 60 * 1000;
    const recent = withUsage.filter(item => Date.parse(item.at) >= first);
    const recentCloud = recent.filter(item => item.cloud);
    const providerTotals = {};
    for (const item of cloud) {
      const name = cbCloudProviderName(item.provider) || 'cloud';
      const entry = providerTotals[name] || { provider: name, hits: 0, input_tokens: 0, output_tokens: 0, cost_micros: 0 };
      entry.hits += 1;
      entry.input_tokens += item.input_tokens || 0;
      entry.output_tokens += item.output_tokens || 0;
      entry.cost_micros += costMicros([item]);
      providerTotals[name] = entry;
    }
    const buckets = new Map();
    for (const item of recent) {
      const at = Date.parse(item.at);
      if (!Number.isFinite(at)) continue;
      const bucket = new Date(Math.floor(at / 60000) * 60000).toISOString();
      const entry = buckets.get(bucket) || { at: bucket, local_hits: 0, cloud_hits: 0, cloud_cost_micros: 0 };
      if (item.cloud) { entry.cloud_hits += 1; entry.cloud_cost_micros += costMicros([item]); }
      else entry.local_hits += 1;
      buckets.set(bucket, entry);
    }
    const value = {
      enabled: true,
      source: 'observed traces and gateway evidence',
      telemetry_quality: withUsage.length
        ? (withUsage.some(item => item.estimated) ? 'cloud usage real; local usage estimated' : 'token-type usage observed')
        : 'token-type usage unavailable',
      pricing: { revision: CB_PRICING_REVISION, model: CB_PRICING_MODEL, currency: 'USD', input_micros_per_million: CB_INPUT_MICROS_PER_MILLION, output_micros_per_million: CB_OUTPUT_MICROS_PER_MILLION, cached_input_micros_per_million: CB_CACHED_INPUT_MICROS_PER_MILLION },
      cloud_hits: cloud.length,
      local_hits: local.length,
      cloud_input_tokens: withUsage.length ? sum(cloud, 'input_tokens') : null,
      cloud_output_tokens: withUsage.length ? sum(cloud, 'output_tokens') : null,
      cloud_cost_micros: withUsage.length ? Math.round(actualCost) : null,
      all_cloud_cost_micros: withUsage.length ? Math.round(allCloudCost) : null,
      saved_vs_all_cloud_micros: withUsage.length ? Math.max(0, Math.round(allCloudCost - actualCost)) : null,
      cloud_providers: Object.values(providerTotals).map(entry => ({ ...entry, cost_micros: Math.round(entry.cost_micros) })),
      recent_cloud_hits: recentCloud.slice(0, 20).map(item => ({ at: item.at, trace_id: item.trace_id, input_tokens: item.input_tokens, output_tokens: item.output_tokens, cost_micros: Math.round(costMicros([item])) })),
      timeline: [...buckets.values()].slice(-60),
      limitations: withUsage.length ? [] : ['The available routing evidence does not expose separate input/output token counts yet. Spend and savings are withheld until token-type usage is observed.'],
    };
    cbCostCache = { expires: Date.now() + 2000, value, pending: null };
    return value;
  })().finally(() => { cbCostCache.pending = null; });
  return cbCostCache.pending;
}

async function cbKubectl(args, timeout = 8000) {
  const contextArgs = CB_CONTEXT === 'in-cluster' ? [] : ['--context', CB_CONTEXT];
  const { stdout } = await execFileAsync('kubectl', [...contextArgs, '-n', CB_NS, ...args], { timeout });
  return stdout;
}

function cbRequireControl(res) {
  if (!TOKEN_CLOUD_BURST || !CB_CONTEXT) {
    res.status(404).json({ enabled: false, error: 'cloud-burst controls are disabled' });
    return false;
  }
  return true;
}

function cbProvider(value) {
  const provider = String(value || '');
  if (CB_LOCAL_PROVIDER_KEYS.includes(provider)) return provider;
  const index = CB_LOCAL_PROVIDER_INDEX.get(provider);
  return index === undefined ? null : CB_LOCAL_PROVIDER_KEYS[index];
}

function cbLocalProviderName(provider) {
  const index = CB_LOCAL_PROVIDER_KEYS.indexOf(String(provider));
  return index >= 0 ? CB_LOCAL_PROVIDER_NAMES[index] : null;
}

function cbSimProviderName(provider) {
  const index = CB_LOCAL_PROVIDER_KEYS.indexOf(String(provider));
  return index >= 0 ? CB_SIM_PROVIDER_NAMES[index] : null;
}

async function cbReconcile() {
  await cbKubectl(['annotate', 'gridnetwork', CB_NETWORK, `grid.praxis-proxy.io/force-reconcile=${Date.now()}`, '--overwrite']);
}

async function cbRunMetric(provider, queue) {
  const providerName = cbSimProviderName(provider);
  if (!providerName) throw new Error(`unknown configured local provider: ${provider}`);
  const name = `${providerName}-config`;
  const document = JSON.parse(await cbKubectl(['get', 'configmap', name, '-o', 'json']));
  const source = document?.data?.['config.yaml'];
  if (typeof source !== 'string') throw new Error(`${name} config.yaml is unavailable`);
  const updated = source.replace(/waiting-requests:\s*[^\n]*/, `waiting-requests: ${queue}`);
  await cbKubectl([
    'patch', 'configmap', name, '--type=merge',
    '-p', JSON.stringify({ data: { 'config.yaml': updated } }),
  ], CB_CONTROL_TIMEOUT);
  await cbKubectl(['rollout', 'restart', `deploy/${providerName}`], CB_CONTROL_TIMEOUT);
  await new Promise(resolve => setTimeout(resolve, 20000));
  cloudBurstControlState.metrics[provider] = queue;
}

async function cbSetProviderDisabled(provider, disabled) {
  const providerName = cbSimProviderName(provider);
  if (!providerName) throw new Error(`unknown configured simulator: ${provider}`);
  // Remove/restore Service endpoints through the simulator Deployment. Grid's
  // normal health evaluation withdraws or restores the candidate; the UI does
  // not forge an overlay or alter request-time routing.
  await cbKubectl(['scale', `deploy/${providerName}`, `--replicas=${disabled ? 0 : 1}`], CB_CONTROL_TIMEOUT);
  cloudBurstControlState.disabled[provider] = disabled;
  cloudBurstControlState.health[provider] = disabled ? 'disabled' : 'healthy';
  await cbReconcile();
}

async function cbRunMetrics(values) {
  for (const [provider, queue] of Object.entries(values)) {
    const providerName = cbSimProviderName(provider);
    if (!providerName) continue;
    const name = `${providerName}-config`;
    const document = JSON.parse(await cbKubectl(['get', 'configmap', name, '-o', 'json']));
    const source = document?.data?.['config.yaml'];
    if (typeof source !== 'string') throw new Error(`${name} config.yaml is unavailable`);
    const updated = source.replace(/waiting-requests:\s*[^\n]*/, `waiting-requests: ${queue}`);
    await cbKubectl([
      'patch', 'configmap', name, '--type=merge',
      '-p', JSON.stringify({ data: { 'config.yaml': updated } }),
    ], CB_CONTROL_TIMEOUT);
  }
  for (const provider of Object.keys(values)) {
    const providerName = cbSimProviderName(provider);
    if (providerName) await cbKubectl(['rollout', 'restart', `deploy/${providerName}`], CB_CONTROL_TIMEOUT);
  }
  await new Promise(resolve => setTimeout(resolve, 20000));
  Object.assign(cloudBurstControlState.metrics, values);
}

async function cbResetMetrics() {
  // Keep reset in the server's in-cluster control path.  The older helper
  // shell script assumes a host kubectl context and is not reliable from an
  // OpenShift UI pod.  Reset every simulator independently, then restart it so
  // the zero gauge is observable before the next Grid reconcile.
  for (const provider of CB_LOCAL_PROVIDER_KEYS) {
    const providerName = cbSimProviderName(provider);
    if (!providerName) continue;
    const name = `${providerName}-config`;
    const document = JSON.parse(await cbKubectl(['get', 'configmap', name, '-o', 'json']));
    const source = document?.data?.['config.yaml'];
    if (typeof source !== 'string') throw new Error(`${name} config.yaml is unavailable`);
    const updated = source.replace(/waiting-requests:\s*[^\n]*/, 'waiting-requests: 0');
    await cbKubectl([
      'patch', 'configmap', name, '--type=merge',
      '-p', JSON.stringify({ data: { 'config.yaml': updated } }),
    ], CB_CONTROL_TIMEOUT);
    await cbKubectl(['rollout', 'restart', `deploy/${providerName}`], CB_CONTROL_TIMEOUT);
  }
  await new Promise(resolve => setTimeout(resolve, 20000));
  cloudBurstControlState.metrics = Object.fromEntries(CB_LOCAL_PROVIDER_KEYS.map(key => [key, 0]));
}

async function cbStopAllPressure() {
  if (cloudBurstPressureJob) cloudBurstPressureJob.cancelled = true;
  await cbResetMetrics();
  // A GPU pressure deployment is optional on simulator-backed installs.
  // Absence is expected and must not make the stop control fail.
  try { await cbKubectl(['scale', 'deploy/epp-load', '--replicas=0'], CB_CONTROL_TIMEOUT); } catch { /* optional */ }
  await cbReconcile();
}

function cbAllocationYaml(source, policy) {
  source = source.replace(/^\s*# allocationRevision: [^\n]+\n/gm, '');
  if (!source.includes('  - filter: token_rate_limit')) {
    throw new Error('token_rate_limit filter is not present in the consumer configuration');
  }
  // The limiter schema is strict: update only fields owned by the actual
  // token_rate_limit filter. Keep the revision as a comment so it can be
  // observed by the demo without becoming an unknown filter field.
  const marker = source.indexOf('  - filter: token_rate_limit');
  const start = marker < 0 ? -1 : source.lastIndexOf('\n', marker) + 1;
  const nextFilter = start < 0 ? -1 : source.slice(start + 1).search(/\n\s+- filter:/);
  const end = nextFilter < 0 ? -1 : start + 1 + nextFilter;
  if (start < 0 || end < 0) throw new Error('consumer configuration has no complete token filter block');
  let block = source.slice(start, end);
  block = block.replace(/\n        allocationPolicy:\n(?:          [^\n]*\n)*/g, '\n');
  if (/\n    enforcement:/.test(block)) {
    block = block.replace(/\n    enforcement: (?:hard|soft)\n/g, `\n    enforcement: ${policy.enforcement}\n`);
  } else {
    block = block.replace(/(\n    reservationTimeout: [^\n]+\n)/, `$1    enforcement: ${policy.enforcement}\n`);
  }
  if (!/\n    enforcement: (?:hard|soft)\n/.test(block)) {
    // Rule-level enforcement is used below; the filter-level default remains
    // unchanged for other principals.
  }
  const ruleMarker = `\n          - name: ${policy.principal}\n`;
  const ruleStart = block.indexOf(ruleMarker);
  if (ruleStart < 0) throw new Error(`consumer configuration has no rule for ${policy.principal}`);
  const ruleEnd = block.indexOf('\n          - name:', ruleStart + ruleMarker.length);
  const ruleLimit = ruleEnd < 0 ? block.length : ruleEnd;
  let rule = block.slice(ruleStart, ruleLimit);
  rule = rule.replace(/\n            enforcement: (?:hard|soft)\n/g, '\n');
  rule = rule.replace(/(\n\s+capacity:)\s*\d+/g, `$1 ${policy.capacity}`);
  rule = rule.replace(ruleMarker, `${ruleMarker}            enforcement: ${policy.enforcement}\n`);
  block = `${block.slice(0, ruleStart)}${rule}${block.slice(ruleLimit)}`;
  block = block.replace(/^\s*# allocationRevision: [^\n]+\n/gm, '');
  block = `# allocationRevision: ${policy.revision}\n${block}`;
  return `${source.slice(0, start)}${block}${source.slice(end)}`;
}

function cbRemoveAllocationYaml(source) {
  source = source.replace(/^\s*# allocationRevision: [^\n]+\n/gm, '');
  const marker = source.indexOf('  - filter: token_rate_limit');
  const start = marker < 0 ? -1 : source.lastIndexOf('\n', marker) + 1;
  const nextFilter = start < 0 ? -1 : source.slice(start + 1).search(/\n\s+- filter:/);
  const end = nextFilter < 0 ? -1 : start + 1 + nextFilter;
  if (start < 0 || end < 0) return source;
  let block = source.slice(start, end);
  block = block.replace(/^\s*# allocationRevision: [^\n]+\n/gm, '');
  for (const [name, capacity] of Object.entries(CB_DEFAULT_ALLOCATIONS)) {
    const ruleMarker = `\n          - name: ${name}\n`;
    const ruleStart = block.indexOf(ruleMarker);
    if (ruleStart < 0) continue;
    const ruleEnd = block.indexOf('\n          - name:', ruleStart + ruleMarker.length);
    const ruleLimit = ruleEnd < 0 ? block.length : ruleEnd;
    let rule = block.slice(ruleStart, ruleLimit);
    rule = rule.replace(/\n\s+enforcement: (?:hard|soft)\n/g, '\n');
    rule = rule.replace(/(\n\s+capacity:)\s*\d+/g, `$1 ${capacity}`);
    block = `${block.slice(0, ruleStart)}${rule}${block.slice(ruleLimit)}`;
  }
  return `${source.slice(0, start)}${block}${source.slice(end)}`;
}

async function cbPublishAllocation(policy = null) {
  const configs = await Promise.all(['a', 'b'].map(async key => {
    const document = JSON.parse(await cbKubectl(['get', 'configmap', CB_CONSUMER_CONFIGS[key], '-o', 'json']));
    const source = document?.data?.['praxis.yaml'];
    if (typeof source !== 'string') throw new Error(`consumer ${key} praxis.yaml is unavailable`);
    return { key, source: policy ? cbAllocationYaml(source, policy) : cbRemoveAllocationYaml(source) };
  }));
  for (const { key, source } of configs) {
    await cbKubectl([
      'patch', 'configmap', CB_CONSUMER_CONFIGS[key], '--type=merge',
      '-p', JSON.stringify({ data: { 'praxis.yaml': source } }),
    ], CB_CONTROL_TIMEOUT);
  }
  return configs.map(({ key }) => key);
}

async function cbReloadObserved(revision, timeoutMs = 90000, startedAt = new Date().toISOString()) {
  const deadline = Date.now() + timeoutMs;
  let observations = ['a', 'b'].map(consumer => ({ consumer, reloaded: false, projected: false }));
  while (Date.now() < deadline) {
    observations = await Promise.all(['a', 'b'].map(async key => {
      try {
        const projectionCheck = revision
          ? `grep -Fq 'allocationRevision: ${revision}' /etc/praxis/praxis.yaml`
          : '! grep -q allocationPolicy /etc/praxis/praxis.yaml';
        const projected = await cbKubectl([
          'exec', `deploy/${CB_CONSUMER_DEPLOYS[key]}`, '-c', 'praxis', '--',
          'sh', '-c', projectionCheck,
        ], 8000).then(() => true).catch(() => false);
        const logs = await cbKubectl(['logs', `deploy/consumer-gateway-${key}`, '-c', 'praxis', `--since-time=${startedAt}`], 8000);
        return { consumer: key, projected, reloaded: projected && /config reload complete/.test(logs) };
      } catch {
        return { consumer: key, projected: false, reloaded: false };
      }
    }));
    if (observations.every(item => item.reloaded)) return observations;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return observations;
}

function cbQueueValue(value, preset) {
  if (preset) {
    if (preset === 'calm') return Math.max(0, Math.floor(CB_QUEUE_CAPACITY * 0.2));
    // The static Kind Grid resource uses queueCapacity=10; value 9 must be
    // above the 0.85 admission-enter threshold rather than merely at 0.8.
    if (preset === 'pressure') return Math.max(9, Math.ceil(CB_QUEUE_CAPACITY * 0.9));
    if (preset === 'saturate') return Math.max(CB_QUEUE_CAPACITY + 1, CB_QUEUE_CAPACITY * 2);
    throw new Error('preset must be calm, pressure, or saturate');
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1000) throw new Error('metric value must be between 0 and 1000');
  return number <= 1 ? Math.round(number * CB_QUEUE_CAPACITY) : Math.round(number);
}

async function cbTrafficRecord(consumer, sessionMode, appOverride = null) {
  const app = appOverride || { id: 'cloud-burst', username: CB_TRAFFIC_PRINCIPAL, password: CB_TRAFFIC_PASSWORD, model: CB_LOGICAL_MODEL, estimateTokens: 5, limit: 100000, windowSeconds: 600 };
  const sessionId = sessionMode === 'sticky'
    ? `cloud-burst-sticky-${consumer}`
    : `cloud-burst-${Date.now()}-${randomUUID()}`;
  cloudBurstTrafficSequence += 1;
  const record = await createTokenRateLimitRecord(consumer, app, { session_id: sessionId });
  const cloud = Boolean(record.external_provider)
    || Boolean(record.response_model && record.response_model !== CB_LOGICAL_MODEL);
  const item = {
    at: record.started_at,
    request_id: record.request_id,
    consumer: record.consumer_gateway,
    provider: record.route.provider_gateway,
    cloud,
    status: record.http.status,
    trace_id: record.trace.trace_id,
    input_tokens: record.input_tokens,
    output_tokens: record.output_tokens,
    total_tokens: record.quota.actual_tokens,
    requested_tokens: record.requested_tokens,
    session: sessionId,
  };
  cloudBurstTrafficHistory.push(item);
  if (cloudBurstTrafficHistory.length > 1000) cloudBurstTrafficHistory.shift();
  return { ...record, cloud, session_id: sessionId };
}

async function runGpuPressureJob(job) {
  const app = TOKEN_RATE_LIMIT_APPS[0]
    ? { ...TOKEN_RATE_LIMIT_APPS[0], maxTokens: 128 }
    : { id: 'cloud-burst-pressure', username: CB_TRAFFIC_PRINCIPAL, password: CB_TRAFFIC_PASSWORD, model: CB_LOGICAL_MODEL, estimateTokens: 20, maxTokens: 128, limit: 100000, windowSeconds: 600 };
  const workers = Math.max(1, Math.min(8, job.concurrency));
  const worker = async (workerId) => {
    while (!job.cancelled && (Date.now() - job.started_ms) < job.duration_ms) {
      const consumer = (job.sequence + workerId) % 2 === 0 ? 'a' : 'b';
      job.sequence += 1;
      try {
        const result = await cbTrafficRecord(consumer, 'unique', app);
        job.completed += 1;
        if (result.http?.status >= 200 && result.http.status < 300) job.succeeded += 1;
        else job.failed += 1;
      } catch { job.failed += 1; }
    }
  };
  await Promise.all(Array.from({ length: workers }, (_, index) => worker(index)));
  job.running = false;
  job.finished_at = new Date().toISOString();
  cbCostCache = { expires: 0, value: null, pending: null };
}

app.post('/api/v1/cloud-burst/metric', async (req, res) => {
  if (!cbRequireControl(res)) return;
  try {
    if (req.body?.reset === true) await cbResetMetrics();
    else {
      const provider = cbProvider(req.body?.provider);
      if (!provider) return res.status(400).json({ error: 'provider must be a, b, or c' });
      await cbRunMetric(provider, cbQueueValue(req.body?.value, req.body?.preset));
    }
    await cbReconcile();
    cloudBurstControlState.last_action = { type: 'metric', at: new Date().toISOString() };
    res.json({ ok: true, controls: cloudBurstControlState });
  } catch (error) { res.status(503).json({ error: error.message }); }
});

app.post('/api/v1/cloud-burst/traffic', async (req, res) => {
  if (!cbRequireControl(res)) return;
  if (!CB_TRAFFIC_PASSWORD || !TOKEN_RATE_LIMIT_CONSUMERS.a || !TOKEN_RATE_LIMIT_CONSUMERS.b) return res.status(503).json({ error: 'server-side traffic credentials or consumers are not configured' });
  const count = Math.min(CB_TRAFFIC_LIMIT, Math.max(1, Number.parseInt(req.body?.count ?? 1, 10) || 1));
  const rate = Math.min(20, Math.max(0, Number(req.body?.rate ?? 0) || 0));
  const sessionMode = req.body?.session === 'sticky' ? 'sticky' : 'unique';
  const requestedApp = TOKEN_RATE_LIMIT_APPS.find(entry => entry.id === req.body?.app) || null;
  const requestedConsumer = req.body?.consumer;
  if (requestedConsumer && !['a', 'b', 'both'].includes(requestedConsumer)) return res.status(400).json({ error: 'consumer must be a, b, or both' });
  const consumers = requestedConsumer === 'a' ? ['a'] : requestedConsumer === 'b' ? ['b'] : ['a', 'b'];
  const results = [];
  for (let i = 0; i < count; i += 1) {
    const consumer = consumers[i % consumers.length];
    try { results.push(await cbTrafficRecord(consumer, sessionMode, requestedApp)); }
    catch (error) { results.push({ error: error.message, consumer: `consumer-gateway-${consumer}` }); }
    if (rate > 0 && i + 1 < count) await new Promise(resolve => setTimeout(resolve, Math.ceil(1000 / rate)));
  }
  cbCostCache = { expires: 0, value: null, pending: null };
  res.json({ ok: results.every(item => !item.error), count: results.length, results, cost: await readCloudBurstCost() });
});

app.post('/api/v1/cloud-burst/weights', async (req, res) => {
  if (!cbRequireControl(res)) return;
  const values = CB_LOCAL_PROVIDER_KEYS.map(key => Number.parseInt(req.body?.[key], 10));
  if (values.length === 0 || values.some(value => !Number.isInteger(value) || value < 1 || value > 1000)) return res.status(400).json({ error: 'weights must be integers from 1 to 1000 for every local provider' });
  try {
    for (const [index, key] of CB_LOCAL_PROVIDER_KEYS.entries()) {
      await cbKubectl(['patch', 'inferenceprovider', CB_LOCAL_PROVIDER_NAMES[index], '--type=merge', '-p', JSON.stringify({ spec: { capacityWeight: values[index] } })]);
      cloudBurstControlState.weights[key] = values[index];
    }
    await cbReconcile();
    res.json({ ok: true, controls: cloudBurstControlState });
  } catch (error) { res.status(503).json({ error: error.message }); }
});

app.post('/api/v1/cloud-burst/overflow-weights', async (req, res) => {
  if (!cbRequireControl(res)) return;
  const openai = Number.parseInt(req.body?.openai, 10);
  const bedrock = Number.parseInt(req.body?.bedrock, 10);
  if (![openai, bedrock].every(value => Number.isInteger(value) && value >= 1 && value <= 1000) || openai < 3) {
    return res.status(400).json({ error: 'overflow weights must be integers from 1 to 1000; OpenAI must be at least 3 for three egress paths' });
  }
  try {
    await cbPatchOverflowWeights(openai, bedrock);
    cloudBurstControlState.overflow_weights = { openai, bedrock };
    await cbReconcile();
    res.json({ ok: true, controls: cloudBurstControlState });
  } catch (error) { res.status(503).json({ error: error.message, controls: cloudBurstControlState }); }
});

app.post('/api/v1/cloud-burst/overflow-health', async (req, res) => {
  if (!cbRequireControl(res)) return;
  const provider = req.body?.provider === 'bedrock' || req.body?.provider === 'openai' ? req.body.provider : null;
  const state = req.body?.state;
  if (!provider || !['healthy', 'unhealthy'].includes(state)) return res.status(400).json({ error: 'provider and healthy|unhealthy state are required' });
  try {
    await cbPatchOverflowHealth(provider, state);
    cloudBurstControlState.overflow_health[provider] = state;
    // Health probes reconcile from the changed InferenceProvider itself. Do
    // not force a GridNetwork reconcile here: that would re-render the
    // provider template and immediately overwrite this live health control.
    res.json({ ok: true, controls: cloudBurstControlState });
  } catch (error) { res.status(503).json({ error: error.message, controls: cloudBurstControlState }); }
});

app.post('/api/v1/cloud-burst/health', async (req, res) => {
  if (!cbRequireControl(res)) return;
  const provider = cbProvider(req.body?.provider);
  const state = req.body?.state;
  if (!provider || !['healthy', 'unhealthy'].includes(state)) return res.status(400).json({ error: 'provider and healthy|unhealthy state are required' });
  try {
    const path = state === 'healthy' ? '/health' : '/__cloud_burst_unhealthy__';
    const providerName = cbLocalProviderName(provider);
    if (!providerName) return res.status(400).json({ error: `unknown configured local provider: ${provider}` });
    await cbKubectl(['patch', 'inferenceprovider', providerName, '--type=merge', '-p', JSON.stringify({ spec: { healthCheck: { path } } })]);
    cloudBurstControlState.health[provider] = state;
    await cbReconcile();
    res.json({ ok: true, controls: cloudBurstControlState });
  } catch (error) { res.status(503).json({ error: error.message }); }
});

app.post('/api/v1/cloud-burst/provider', async (req, res) => {
  if (!cbRequireControl(res)) return;
  const provider = cbProvider(req.body?.provider);
  if (!provider) return res.status(400).json({ error: 'provider must be a configured local simulator' });
  if (typeof req.body?.disabled !== 'boolean') return res.status(400).json({ error: 'disabled must be boolean' });
  try {
    await cbSetProviderDisabled(provider, req.body.disabled);
    cloudBurstControlState.last_action = { type: req.body.disabled ? 'provider_disabled' : 'provider_enabled', id: provider, at: new Date().toISOString() };
    res.json({ ok: true, provider, disabled: req.body.disabled, controls: cloudBurstControlState });
  } catch (error) { res.status(503).json({ error: error.message, controls: cloudBurstControlState }); }
});

app.post('/api/v1/cloud-burst/allocation', async (req, res) => {
  if (!cbRequireControl(res)) return;
  const principal = typeof req.body?.principal === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(req.body.principal) ? req.body.principal : CB_TRAFFIC_PRINCIPAL;
  const enforcement = req.body?.enforcement === 'hard' ? 'hard' : 'soft';
  const limit = req.body?.limit === undefined ? null : Number.parseInt(req.body.limit, 10);
  if (req.body?.reset === true) {
    try {
      const reloadStartedAt = new Date().toISOString();
      await cbPublishAllocation();
      cloudBurstControlState.allocation = { principal: CB_TRAFFIC_PRINCIPAL, limit: null, enforcement: 'soft', revision: 0, verified: false };
      const reload = await cbReloadObserved(null, 90000, reloadStartedAt);
      res.json({ ok: true, controls: cloudBurstControlState, reload });
    } catch (error) {
      res.status(503).json({ error: error.message, controls: cloudBurstControlState });
    }
    return;
  }
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0 || limit > 1000000)) return res.status(400).json({ error: 'limit must be between 1 and 1000000' });
  if (principal !== CB_TRAFFIC_PRINCIPAL) return res.status(400).json({ error: 'only the configured bounded traffic principal is supported by this demo control', principal });
  if (limit === null) return res.status(400).json({ error: 'limit is required for a versioned allocation policy' });
  try {
    const revision = `ui-${Date.now()}`;
    const reloadStartedAt = new Date().toISOString();
    await cbPublishAllocation({ principal, revision, capacity: limit, enforcement });
    cloudBurstControlState.allocation = { principal, limit, enforcement, revision, verified: false };
    const reload = await cbReloadObserved(revision, 90000, reloadStartedAt);
    cloudBurstControlState.last_action = { type: 'allocation', at: new Date().toISOString() };
    res.json({ ok: true, controls: cloudBurstControlState, reload, verification: 'reload observed; enforcement still requires a passing quota exercise' });
  } catch (error) {
    res.status(503).json({ error: error.message, controls: cloudBurstControlState });
  }
});

app.post('/api/v1/cloud-burst/scenario', async (req, res) => {
  if (!cbRequireControl(res)) return;
  const id = String(req.body?.id || '');
  const scenarios = {
    baseline: { metrics: { a: 0, b: 0, c: 0 }, weights: { a: 50, b: 30, c: 20 } },
    partial: { metrics: { a: 9, b: 0, c: 0 } },
    progressive: { metrics: { a: 9, b: 9, c: 0 } },
    full: { metrics: { a: 9, b: 9, c: 9 } },
    recovery: { metrics: { a: 0, b: 0, c: 0 }, weights: { a: 50, b: 30, c: 20 } },
    reweight_60_30_10: { metrics: { a: 0, b: 0, c: 0 }, weights: { a: 60, b: 30, c: 10 } },
    reweight_equal: { metrics: { a: 0, b: 0, c: 0 }, weights: { a: 33, b: 33, c: 33 } },
  };
  const scenario = scenarios[id];
  if (!scenario) return res.status(400).json({ error: 'unknown scenario', allowed: Object.keys(scenarios) });
  try {
    if (scenario.weights) {
      for (const [index, key] of CB_LOCAL_PROVIDER_KEYS.entries()) await cbKubectl(['patch', 'inferenceprovider', CB_LOCAL_PROVIDER_NAMES[index], '--type=merge', '-p', JSON.stringify({ spec: { capacityWeight: scenario.weights[key] } })]);
      cloudBurstControlState.weights = { ...scenario.weights };
    }
    for (const key of CB_LOCAL_PROVIDER_KEYS) await cbRunMetric(key, scenario.metrics[key] ?? 0);
    await cbReconcile();
    cloudBurstControlState.last_action = { type: 'scenario', id, at: new Date().toISOString() };
    res.json({ ok: true, scenario: id, controls: cloudBurstControlState });
  } catch (error) { res.status(503).json({ error: error.message }); }
});

app.get('/api/v1/cloud-burst', async (_req, res) => {
  if (!TOKEN_CLOUD_BURST || !CB_CONTEXT) return res.json({ enabled: false });
  try {
    const raw = await cbKubectl(['get', 'configmap', CB_OVERLAY_CM, '-o',
      'jsonpath={.data.routing-overlay\\.json}']);
    const document = JSON.parse(raw);
    // The Grid operator exposes the semantic overlay in routing-config.json,
    // while the Praxis validator consumes the enveloped routing-overlay.json.
    // Accept both shapes so the RHOAI UI reads the live operator ConfigMap.
    const ov = document.overlay || document;
    const overlayRevision = document.revision || null;
    const groups = (ov.candidates || []).map((c) => {
      // Grid overlays use `name` for the capability/model. Older demo
      // fixtures used `model`; accept both so the live topology is driven by
      // the actual overlay rather than a fixture-specific field.
      const model = c.name || c.model || '';
      const identity = `${model} ${c.site || ''} ${c.cluster || ''}`;
      const bedrock = /bedrock/i.test(identity);
      const openai = /openai|cloud/i.test(identity);
      const suffix = String(c.cluster || c.site || '').match(/(?:static-)?(?:openai-)?([abc])$/i)?.[1]?.toLowerCase();
      const external = Boolean(c.credential) || c.backend_kind === 'api_provider' || openai || bedrock;
      return {
        site: c.site, cluster: c.cluster, model, group: c.selection_group ?? 0,
        admission: c.admission_state || null, tier: c.selection_tier || null,
        external,
        // backend_kind is intentionally not used to label cloud providers:
        // both OpenAI and Bedrock are generic api_provider routes. The
        // provider identity comes from the accepted candidate name.
        provider: bedrock ? 'bedrock' : external ? 'openai' : 'local',
        // The static resources use one provider gateway per local suffix.
        // Bedrock is the standalone overflow endpoint attached to gateway A;
        // it is still rendered as its own overflow candidate below that card.
        // The live RHOAI overlay identifies the provider gateway in `cluster`.
        // Keep that name in the UI; `static-*` is only a legacy demo fallback.
        gateway: c.gateway || c.routing_cluster || c.cluster || (bedrock ? 'static-a' : (suffix ? `static-${suffix}` : null)),
      };
    });
    const local = groups.find((g) => !g.external) || {};
    let queue = null;
    let gpuMetrics = [];
    if (CB_DEFAULT_MODE === 'gpu') {
      gpuMetrics = await cbReadGpuMetrics();
      const waiting = gpuMetrics.map(item => item.waiting).filter(value => typeof value === 'number');
      if (waiting.length) queue = Math.max(...waiting);
    }
    try {
      const eppIp = (await cbKubectl(['get', 'pod', '-l', 'app.kubernetes.io/name=llmd-epp',
        '-o', 'jsonpath={.items[0].status.podIP}'])).trim();
      if (eppIp) {
        const m = await cbKubectl(['exec', 'deploy/grid-operator', '--', 'sh', '-c',
          `wget -qO- http://${eppIp}:9090/metrics 2>/dev/null`], 9000);
        const line = m.split('\n').find((l) => l.startsWith(`${CB_QUEUE_METRIC}{`) || l.startsWith(`${CB_QUEUE_METRIC} `));
        if (line) queue = Number.parseFloat(line.trim().split(/\s+/).pop());
      }
    } catch { /* EPP optional */ }
    // Simulator mode has a deterministic queue value even when this
    // deployment has no EPP metrics service. Keep the gauge aligned with the
    // metric that drives Grid admission instead of displaying 0%/unknown.
    if (queue == null && CB_DEFAULT_MODE === 'sim') {
      queue = Math.max(...Object.values(cloudBurstControlState.metrics).map(Number), 0);
    }
    let loadReplicas = CB_DEFAULT_MODE === 'gpu' ? (cloudBurstPressureJob?.running ? cloudBurstPressureJob.concurrency : 0) : 0;
    if (CB_DEFAULT_MODE !== 'gpu') {
      try { loadReplicas = Number.parseInt((await cbKubectl(['get', 'deploy', CB_LOAD_DEPLOY,
        '-o', 'jsonpath={.spec.replicas}'])).trim() || '0', 10); } catch { /* no load deploy */ }
    }
    const defCap = CB_MODES[CB_DEFAULT_MODE].capacity;
    const pressure = queue != null && defCap > 0
      ? Math.max(0, Math.min(1, queue / defCap)) : null;
    res.json({
      enabled: true, external_target: CB_EXTERNAL_TARGET,
      queue_depth: queue, queue_capacity: defCap, pressure,
      modes: CB_MODES, default_mode: CB_DEFAULT_MODE,
      load_on: loadReplicas > 0, load_replicas: loadReplicas,
      gpu_metrics: gpuMetrics,
      local_admission: local.admission || null,
      pressure_active: local.admission === 'existing_only',
      // A recent cloud hit remains in the cost/history panels after recovery,
      // but the live badge must describe the current routing state. Cloud
      // burst is active only while local admission is pressured and recent
      // traffic actually used the overflow path.
      cloud_burst_active: local.admission === 'existing_only'
        && cloudBurstTrafficHistory.some(item => item.cloud && Date.parse(item.at) >= Date.now() - 60_000),
      // Compatibility for older UI clients; new clients use the explicit
      // pressure_active/cloud_burst_active fields above.
      burst_active: local.admission === 'existing_only'
        && cloudBurstTrafficHistory.some(item => item.cloud && Date.parse(item.at) >= Date.now() - 60_000),
      overlay_revision: overlayRevision, groups,
      controls: {
        providers: CB_LOCAL_PROVIDER_KEYS.map((key, index) => ({ key, name: CB_LOCAL_PROVIDER_NAMES[index], simulator: CB_SIM_PROVIDER_NAMES[index] })),
        metrics: cloudBurstControlState.metrics,
        health: cloudBurstControlState.health,
        disabled: cloudBurstControlState.disabled,
        weights: cloudBurstControlState.weights,
        overflow_weights: cloudBurstControlState.overflow_weights,
        overflow_health: cloudBurstControlState.overflow_health,
        allocation: cloudBurstControlState.allocation,
        last_action: cloudBurstControlState.last_action,
      },
    });
  } catch (error) {
    res.json({ enabled: true, error: String(error.message || error) });
  }
});

app.post('/api/v1/cloud-burst/load', async (req, res) => {
  if (!TOKEN_CLOUD_BURST || !CB_CONTEXT) return res.status(400).json({ error: 'cloud-burst not enabled' });
  const on = req.body?.on === true || req.body?.on === 'true';
  const mode = cbMode(req.body?.mode);
  const replicas = on ? CB_MODES[mode].replicas : 0;
  try {
    if (mode === 'gpu') {
      if (!on) {
        if (cloudBurstPressureJob) cloudBurstPressureJob.cancelled = true;
        return res.json({ ok: true, load_on: false, mode, replicas: 0 });
      }
      if (cloudBurstPressureJob?.running) return res.status(409).json({ error: 'GPU pressure is already running', job: cloudBurstPressureJob });
      cloudBurstPressureJob = { running: true, cancelled: false, mode, concurrency: Math.max(2, replicas * 4), duration_ms: 300000, started_ms: Date.now(), started_at: new Date().toISOString(), completed: 0, succeeded: 0, failed: 0, sequence: 0 };
      runGpuPressureJob(cloudBurstPressureJob).catch(error => { if (cloudBurstPressureJob) { cloudBurstPressureJob.running = false; cloudBurstPressureJob.error = error.message; } });
      return res.json({ ok: true, load_on: true, mode, replicas: cloudBurstPressureJob.concurrency });
    }
    if (mode === 'sim') {
      if (on) {
        const pressureQueue = cbQueueValue(undefined, 'pressure');
        await cbRunMetrics(Object.fromEntries(CB_LOCAL_PROVIDER_KEYS.map(provider => [provider, pressureQueue])));
        await cbReconcile();
        return res.json({ ok: true, load_on: true, mode, replicas: CB_MODES[mode].replicas });
      }
      await cbStopAllPressure();
      return res.json({ ok: true, load_on: false, mode, replicas: 0 });
    }
    await cbKubectl(['scale', `deploy/${CB_LOAD_DEPLOY}`, `--replicas=${replicas}`]);
    res.json({ ok: true, load_on: on, mode, replicas });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.post('/api/v1/cloud-burst/stop', async (_req, res) => {
  if (!TOKEN_CLOUD_BURST || !CB_CONTEXT) return res.status(400).json({ error: 'cloud-burst not enabled' });
  try {
    await cbStopAllPressure();
    res.json({ ok: true, load_on: false, pressure: 'off' });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.get('/api/v1/cloud-burst/cost', async (_req, res) => {
  try {
    res.json(await readCloudBurstCost());
  } catch (error) {
    res.status(503).json({ enabled: true, error: 'cloud-burst cost telemetry unavailable' });
  }
});

// The React build owns browser routes; API misses must remain API misses.
const spaIndex = join(distRoot, 'index.html');
app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found' }));
if (existsSync(spaIndex)) {
  app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => res.sendFile(spaIndex));
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const server = app.listen(PORT, () => {
  console.log(`Routing Observability UI running at http://localhost:${PORT}`);
  console.log(`Jaeger endpoint: ${JAEGER_URL}`);
  console.log(`Mode: ${currentMode} (auto-detects Jaeger availability)`);
});

export { app, server };
