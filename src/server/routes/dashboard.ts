import type { FastifyInstance } from 'fastify'
import type { RouterConfig } from '../../config/router-config.js'
import type { StatsCollector } from '../../stats/collector.js'

export function registerDashboardRoute(
  app: FastifyInstance,
  stats: StatsCollector,
  getRouterConfig: () => RouterConfig,
): void {
  app.get('/dashboard', async (_request, reply) => {
    const refreshSeconds = getRouterConfig().dashboard?.refreshSeconds ?? 5
    return reply
      .type('text/html; charset=utf-8')
      .send(buildDashboardHtml(stats.getSummary(), refreshSeconds))
  })
}

function buildDashboardHtml(summary: ReturnType<StatsCollector['getSummary']>, refreshSeconds: number): string {
  const initialData = JSON.stringify(summary).replace(/</g, '\\u003c')

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>claw-auto-router dashboard</title>
  <style>
    :root {
      --bg: #f4efe6;
      --panel: rgba(255,255,255,0.82);
      --line: rgba(32,34,36,0.12);
      --text: #182026;
      --muted: #6c737a;
      --accent: #0f7b6c;
      --accent-2: #c96e2c;
      --danger: #b23b3b;
      --ok: #1f7a3d;
      --shadow: 0 18px 60px rgba(20, 26, 28, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", "Avenir Next", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(15,123,108,0.13), transparent 28%),
        radial-gradient(circle at top right, rgba(201,110,44,0.12), transparent 22%),
        linear-gradient(180deg, #faf7f1 0%, var(--bg) 100%);
      min-height: 100vh;
    }
    .wrap {
      max-width: 1200px;
      margin: 0 auto;
      padding: 32px 20px 60px;
    }
    .hero {
      display: flex;
      justify-content: space-between;
      gap: 20px;
      align-items: end;
      margin-bottom: 24px;
    }
    h1 {
      margin: 0;
      font-size: clamp(2rem, 4vw, 3.4rem);
      letter-spacing: -0.04em;
    }
    .hero p {
      margin: 10px 0 0;
      color: var(--muted);
      max-width: 760px;
      line-height: 1.5;
    }
    .pill {
      padding: 10px 14px;
      background: rgba(255,255,255,0.7);
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      white-space: nowrap;
    }
    .grid {
      display: grid;
      gap: 16px;
      grid-template-columns: repeat(12, 1fr);
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 22px;
      box-shadow: var(--shadow);
      padding: 18px 18px 16px;
      backdrop-filter: blur(12px);
    }
    .span-3 { grid-column: span 3; }
    .span-4 { grid-column: span 4; }
    .span-5 { grid-column: span 5; }
    .span-6 { grid-column: span 6; }
    .span-7 { grid-column: span 7; }
    .span-8 { grid-column: span 8; }
    .span-12 { grid-column: span 12; }
    .label {
      color: var(--muted);
      font-size: 0.84rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .value {
      font-size: clamp(1.7rem, 2vw, 2.5rem);
      font-weight: 700;
      margin-top: 10px;
    }
    .subvalue {
      margin-top: 6px;
      color: var(--muted);
      font-size: 0.95rem;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.95rem;
    }
    th, td {
      padding: 10px 8px;
      text-align: left;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .bar {
      height: 10px;
      border-radius: 999px;
      background: rgba(24,32,38,0.08);
      overflow: hidden;
      margin-top: 8px;
    }
    .bar > span {
      display: block;
      height: 100%;
      background: linear-gradient(90deg, var(--accent), #4fa98d);
      border-radius: inherit;
    }
    .muted { color: var(--muted); }
    .ok { color: var(--ok); }
    .danger { color: var(--danger); }
    code {
      font-family: "SFMono-Regular", "JetBrains Mono", monospace;
      font-size: 0.9em;
      background: rgba(24,32,38,0.05);
      padding: 2px 6px;
      border-radius: 7px;
    }
    @media (max-width: 920px) {
      .span-3, .span-4, .span-5, .span-6, .span-7, .span-8 { grid-column: span 12; }
      .hero { flex-direction: column; align-items: start; }
      .pill { white-space: normal; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <div>
        <h1>claw-auto-router dashboard</h1>
        <p>Live routing health, tier distribution, estimated spend, fallback behavior, and active conversation overrides in one place.</p>
      </div>
      <div class="pill">Auto-refresh every ${refreshSeconds}s</div>
    </div>
    <div class="grid" id="dashboard-root"></div>
  </div>
  <script>
    const initialData = ${initialData};

    function formatUsd(value) {
      return '$' + Number(value ?? 0).toFixed(4);
    }

    function formatPercent(value, total) {
      if (!total) return '0%';
      return Math.round((value / total) * 100) + '%';
    }

    function renderBar(value, total) {
      const percent = total > 0 ? (value / total) * 100 : 0;
      return '<div class="bar"><span style="width:' + percent + '%"></span></div>';
    }

    function escapeHtml(value) {
      return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    }

    function renderDashboard(data) {
      const total = data.totalRequests ?? 0;
      const tierRows = Object.entries(data.tierStats ?? {});
      const classifierRows = Object.entries(data.classifierStats ?? {});
      const providerRows = Object.entries(data.providerStats ?? {}).sort((a, b) => (b[1].requestCount ?? 0) - (a[1].requestCount ?? 0));
      const requestsRows = data.recentRequests ?? [];
      const overrideRows = data.sessionStats?.recentOverrides ?? [];

      return [
        '<section class="card span-3"><div class="label">Requests</div><div class="value">' + total + '</div><div class="subvalue">fallbacks ' + (data.fallbackCount ?? 0) + ' · avg ' + (data.averageDurationMs ?? 0) + 'ms</div></section>',
        '<section class="card span-3"><div class="label">Success Rate</div><div class="value">' + formatPercent(data.successfulRequests ?? 0, total) + '</div><div class="subvalue">' + (data.successfulRequests ?? 0) + ' success / ' + (data.failedRequests ?? 0) + ' failed</div></section>',
        '<section class="card span-3"><div class="label">Estimated Spend</div><div class="value">' + formatUsd(data.costSummary?.estimatedCostUsd ?? 0) + '</div><div class="subvalue">' + (data.costSummary?.meteredRequests ?? 0) + ' metered · ' + (data.costSummary?.unmeteredRequests ?? 0) + ' unmetered</div></section>',
        '<section class="card span-3"><div class="label">Estimated Savings</div><div class="value">' + formatUsd(data.costSummary?.estimatedSavingsUsd ?? 0) + '</div><div class="subvalue">baseline ' + escapeHtml(data.costSummary?.baselineModelId ?? 'not set') + '</div></section>',
        '<section class="card span-5"><div class="label">Tier Distribution</div>' + tierRows.map(([tier, count]) => '<div style="margin-top:14px"><strong>' + tier + '</strong> <span class="muted">' + count + ' requests</span>' + renderBar(count, total) + '</div>').join('') + '</section>',
        '<section class="card span-3"><div class="label">Classifier Modes</div>' + classifierRows.map(([mode, count]) => '<div style="margin-top:14px"><strong>' + mode + '</strong> <span class="muted">' + count + ' requests</span>' + renderBar(count, total) + '</div>').join('') + '</section>',
        '<section class="card span-4"><div class="label">Active Overrides</div><div class="value">' + (data.sessionStats?.activeOverrides ?? 0) + '</div><div class="subvalue">' + (data.sessionStats?.overrideRequests ?? 0) + ' routed requests used an override</div></section>',
        '<section class="card span-12"><div class="label">Provider Usage</div><table><thead><tr><th>Model</th><th>Requests</th><th>Attempts</th><th>Success</th><th>Estimated Cost</th></tr></thead><tbody>' + (providerRows.length > 0 ? providerRows.map(([modelId, stat]) => '<tr><td><code>' + escapeHtml(modelId) + '</code></td><td>' + (stat.requestCount ?? 0) + '</td><td>' + (stat.attempts ?? 0) + '</td><td>' + (stat.successes ?? 0) + '</td><td>' + formatUsd(stat.estimatedCostUsd ?? 0) + '</td></tr>').join('') : '<tr><td colspan="5" class="muted">No routed requests yet.</td></tr>') + '</tbody></table></section>',
        '<section class="card span-7"><div class="label">Recent Routing History</div><table><thead><tr><th>Time</th><th>Tier</th><th>Resolved Model</th><th>Mode</th><th>Cost</th></tr></thead><tbody>' + (requestsRows.length > 0 ? requestsRows.slice(0, 20).map((record) => '<tr><td>' + new Date(record.timestamp).toLocaleTimeString() + '</td><td>' + escapeHtml(record.tier) + '</td><td><code>' + escapeHtml(record.resolvedModel) + '</code></td><td>' + escapeHtml(record.classifierMode) + (record.overrideSummary ? '<div class="muted">' + escapeHtml(record.overrideSummary) + '</div>' : '') + '</td><td>' + (record.estimatedCostUsd !== undefined ? formatUsd(record.estimatedCostUsd) : '<span class="muted">n/a</span>') + '</td></tr>').join('') : '<tr><td colspan="5" class="muted">No history yet.</td></tr>') + '</tbody></table></section>',
        '<section class="card span-5"><div class="label">Recent Conversation Overrides</div><table><thead><tr><th>Session</th><th>Override</th><th>Updated</th></tr></thead><tbody>' + (overrideRows.length > 0 ? overrideRows.map((entry) => {
          const parts = [];
          if (entry.explicitModelId) parts.push('model=' + entry.explicitModelId);
          if (entry.forcedTier) parts.push('tier=' + entry.forcedTier);
          if (entry.thinking) parts.push('thinking');
          return '<tr><td><code>' + escapeHtml(entry.sessionId) + '</code></td><td>' + escapeHtml(parts.join(', ') || 'n/a') + '</td><td>' + new Date(entry.updatedAt).toLocaleTimeString() + '</td></tr>';
        }).join('') : '<tr><td colspan="3" class="muted">No active conversation overrides.</td></tr>') + '</tbody></table></section>',
      ].join('');
    }

    async function refresh() {
      try {
        const response = await fetch('/stats');
        const data = await response.json();
        document.getElementById('dashboard-root').innerHTML = renderDashboard(data);
      } catch (error) {
        document.getElementById('dashboard-root').innerHTML = '<section class="card span-12"><div class="label">Dashboard</div><div class="value danger">Failed to refresh dashboard</div><div class="subvalue">' + escapeHtml(String(error)) + '</div></section>';
      }
    }

    document.getElementById('dashboard-root').innerHTML = renderDashboard(initialData);
    setInterval(refresh, ${refreshSeconds * 1000});
  </script>
</body>
</html>`
}
