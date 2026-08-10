#!/usr/bin/env node

import http from 'http';

const API_URL = process.env.API_URL || 'http://localhost:3001';
const isTTY = process.stdout.isTTY;

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgRed: '\x1b[41m',
};

function c(color, text) {
  return isTTY ? `${ANSI[color]}${text}${ANSI.reset}` : text;
}

function pressureColor(level) {
  switch (level) {
    case 'normal': return 'green';
    case 'elevated': return 'yellow';
    case 'high': return 'magenta';
    case 'critical': return 'red';
    default: return 'gray';
  }
}

function formatRatio(v) {
  if (typeof v !== 'number') return '—';
  return Math.round(v * 100) + '%';
}

function formatScore(v) {
  if (typeof v !== 'number') return '—';
  return v.toFixed(2);
}

function pad(s, w) {
  s = String(s);
  return s.length >= w ? s.substring(0, w) : s + ' '.repeat(w - s.length);
}

function rpad(s, w) {
  s = String(s);
  return s.length >= w ? s.substring(0, w) : ' '.repeat(w - s.length) + s;
}

function apiFetch(path) {
  return new Promise((resolve, reject) => {
    const url = `${API_URL}/api${path}`;
    http.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`parse error from ${url}`)); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

async function main() {
  let providers;
  try {
    providers = await apiFetch('/providers');
  } catch (err) {
    console.error(`Failed to reach API at ${API_URL}: ${err.message}`);
    console.error('Set API_URL if the server is running on a different address.');
    process.exit(1);
  }

  const legend = [
    'Pressure legend:',
    '  NORMAL    fresh signal below 0.50',
    '  ELEVATED  fresh signal 0.50–0.79',
    '  HIGH      fresh signal 0.80–0.94',
    '  CRITICAL  fresh signal 0.95–1.00',
    '  UNKNOWN   missing signal',
    '',
    'Score is calculated from measured routing signals.',
    `Scoring strategy: ${providers.scoring_strategy || 'unknown'}`,
    `Mode: ${providers.mode || 'unknown'}`,
    '',
  ];
  console.log(legend.join('\n'));

  const cols = [
    { key: 'name', label: 'Provider', width: 22 },
    { key: 'pressure', label: 'Pressure', width: 10 },
    { key: 'queue', label: 'Queue', width: 8 },
    { key: 'kv', label: 'KV Cache', width: 8 },
    { key: 'score', label: 'Score', width: 7 },
    { key: 'rank', label: 'Rank', width: 6 },
    { key: 'admission', label: 'Admission', width: 18 },
    { key: 'reqs', label: 'Requests', width: 8 },
    { key: 'healthy', label: 'Healthy', width: 7 },
  ];

  const sep = '+' + cols.map(col => '-'.repeat(col.width + 2)).join('+') + '+';
  const header = '|' + cols.map(col => ' ' + pad(col.label, col.width) + ' ').join('|') + '|';

  console.log(sep);
  console.log(c('bold', header));
  console.log(sep);

  for (const p of (providers.providers || [])) {
    const pLevel = (p.pressure_level || 'unknown').toUpperCase();
    const pColor = pressureColor(p.pressure_level || 'unknown');
    const name = p.cluster || p.name || '—';
    const rank = typeof p.rank === 'number' ? (p.rank === -1 ? '—' : '#' + (p.rank + 1)) : '—';

    const row = '|'
      + ' ' + pad(name, 22) + ' |'
      + ' ' + c(pColor, pad('[' + pLevel + ']', 10)) + ' |'
      + ' ' + rpad(formatRatio(p.queue_depth), 8) + ' |'
      + ' ' + rpad(formatRatio(p.kv_cache), 8) + ' |'
      + ' ' + rpad(formatScore(p.score), 7) + ' |'
      + ' ' + rpad(rank, 6) + ' |'
      + ' ' + pad(p.admission_state || '—', 18) + ' |'
      + ' ' + rpad(typeof p.request_count === 'number' ? String(p.request_count) : '—', 8) + ' |';

    console.log(row);
  }

  console.log(sep);

  if (providers.overlay_revision) {
    console.log(`\nOverlay revision: ${providers.overlay_revision}`);
  }
  if (providers.generated_at) {
    console.log(`Generated at: ${providers.generated_at}`);
  }
}

main();
