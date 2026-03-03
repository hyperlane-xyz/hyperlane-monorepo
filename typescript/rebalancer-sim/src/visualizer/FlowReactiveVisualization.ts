import type {
  FlowReactiveComparisonReport,
  StrategyRunResult,
  StrategyScorecard,
} from '../types.js';

/** Strategy color palette */
const STRATEGY_COLORS: Record<string, string> = {
  emaFlow: '#4CAF50',
  velocityFlow: '#2196F3',
  thresholdFlow: '#FF9800',
  accelerationFlow: '#9C27B0',
};

const DEFAULT_COLOR = '#607D8B';

function getStrategyColor(strategyType: string): string {
  return STRATEGY_COLORS[strategyType] ?? DEFAULT_COLOR;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatVolume(value: bigint): string {
  return (Number(value) / 1e18).toFixed(2);
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Generates HTML comparison visualization for flow-reactive strategy runs.
 * Produces a self-contained HTML file with:
 * - Scenario header (name, description)
 * - Scorecard table with all strategies ranked
 * - Per-strategy KPI comparison charts
 * - Winner highlight
 */
export function generateFlowReactiveComparisonHtml(
  report: FlowReactiveComparisonReport,
): string {
  const serializedData = JSON.stringify(report, bigintReplacer, 2);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Flow-Reactive Strategy Comparison: ${escapeHtml(report.scenarioName)}</title>
  <style>
${getStyles()}
  </style>
</head>
<body>
  <div class="container">
    ${renderHeader(report)}
    ${renderScorecardTable(report.scorecard)}
    ${renderKpiBars(report)}
    ${renderStrategyCards(report.results)}
  </div>

  <script>
    // Embedded data for potential interactive features
    const reportData = ${serializedData};
  </script>
</body>
</html>`;
}

function renderHeader(report: FlowReactiveComparisonReport): string {
  const desc = report.scenarioDescription
    ? `<p class="description">${escapeHtml(report.scenarioDescription)}</p>`
    : '';
  return `
    <div class="header-bar">
      <h1>Flow-Reactive Strategy Comparison</h1>
    </div>
    <h2>${escapeHtml(report.scenarioName)}</h2>
    ${desc}
    <div class="winner-banner">
      &#127942; Winner: <strong>${escapeHtml(report.winner)}</strong> &mdash; ${escapeHtml(report.summary)}
    </div>`;
}

function renderScorecardTable(scorecard: StrategyScorecard[]): string {
  const sorted = [...scorecard].sort((a, b) => a.rank - b.rank);
  const winnerName = sorted[0]?.strategyName ?? '';

  const rows = sorted
    .map((s) => {
      const color = getStrategyColor(s.strategyType);
      const isWinner = s.strategyName === winnerName;
      const rowClass = isWinner ? ' class="winner-row"' : '';
      return `
        <tr${rowClass}>
          <td>${s.rank}</td>
          <td><span class="color-dot" style="background:${color};"></span>${escapeHtml(s.strategyName)}</td>
          <td>${escapeHtml(s.strategyType)}</td>
          <td>${(s.completionRate * 100).toFixed(1)}%</td>
          <td>${s.totalRebalances}</td>
          <td>${formatVolume(s.rebalanceVolume)}</td>
          <td>${s.averageLatency.toFixed(0)}</td>
          <td>${s.efficiency.toFixed(3)}</td>
        </tr>`;
    })
    .join('');

  return `
    <h3>Strategy Scorecard</h3>
    <table class="scorecard">
      <thead>
        <tr>
          <th>Rank</th>
          <th>Strategy</th>
          <th>Type</th>
          <th>Completion %</th>
          <th>Rebalances</th>
          <th>Rebalance Volume</th>
          <th>Avg Latency (ms)</th>
          <th>Efficiency</th>
        </tr>
      </thead>
      <tbody>${rows}
      </tbody>
    </table>`;
}

function renderKpiBars(report: FlowReactiveComparisonReport): string {
  const results = report.results;
  if (results.length === 0) return '';

  const maxLatency = Math.max(...results.map((r) => r.kpis.averageLatency), 1);
  const maxRebalances = Math.max(
    ...results.map((r) => r.kpis.totalRebalances),
    1,
  );
  const maxVolume = Math.max(
    ...results.map((r) => Number(r.kpis.rebalanceVolume)),
    1,
  );

  const completionBars = results
    .map((r) => {
      const pct = r.kpis.completionRate * 100;
      const color = getStrategyColor(r.strategyType);
      return barRow(r.strategyName, pct, color, `${pct.toFixed(1)}%`);
    })
    .join('');

  const latencyBars = results
    .map((r) => {
      const pct = (r.kpis.averageLatency / maxLatency) * 100;
      const color = getStrategyColor(r.strategyType);
      return barRow(
        r.strategyName,
        pct,
        color,
        `${r.kpis.averageLatency.toFixed(0)}ms`,
      );
    })
    .join('');

  const rebalanceBars = results
    .map((r) => {
      const pct = (r.kpis.totalRebalances / maxRebalances) * 100;
      const color = getStrategyColor(r.strategyType);
      return barRow(r.strategyName, pct, color, `${r.kpis.totalRebalances}`);
    })
    .join('');

  const volumeBars = results
    .map((r) => {
      const vol = Number(r.kpis.rebalanceVolume);
      const pct = (vol / maxVolume) * 100;
      const color = getStrategyColor(r.strategyType);
      return barRow(
        r.strategyName,
        pct,
        color,
        `${formatVolume(r.kpis.rebalanceVolume)} tokens`,
      );
    })
    .join('');

  return `
    <h3>KPI Comparison</h3>
    <div class="kpi-bars">
      <div class="bar-group">
        <div class="bar-label">Completion Rate</div>
        ${completionBars}
      </div>
      <div class="bar-group">
        <div class="bar-label">Average Latency</div>
        ${latencyBars}
      </div>
      <div class="bar-group">
        <div class="bar-label">Total Rebalances</div>
        ${rebalanceBars}
      </div>
      <div class="bar-group">
        <div class="bar-label">Rebalance Volume</div>
        ${volumeBars}
      </div>
    </div>`;
}

function barRow(
  name: string,
  pct: number,
  color: string,
  label: string,
): string {
  const clampedPct = Math.max(0, Math.min(100, pct));
  return `
      <div class="bar-row">
        <span class="bar-name">${escapeHtml(name)}</span>
        <div class="bar-track">
          <div class="bar-fill" style="width: ${clampedPct.toFixed(1)}%; background: ${color};">
            ${escapeHtml(label)}
          </div>
        </div>
      </div>`;
}

function renderStrategyCards(results: StrategyRunResult[]): string {
  const cards = results
    .map((r) => {
      const color = getStrategyColor(r.strategyType);
      const kpis = r.kpis;
      return `
      <div class="strategy-card">
        <div class="card-header" style="border-left: 4px solid ${color};">
          <h4>${escapeHtml(r.strategyName)}</h4>
          <span class="strategy-badge" style="background:${color};">${escapeHtml(r.strategyType)}</span>
        </div>
        <div class="card-body">
          <div class="card-kpi">
            <span class="card-kpi-label">Completion</span>
            <span class="card-kpi-value">${(kpis.completionRate * 100).toFixed(1)}%</span>
          </div>
          <div class="card-kpi">
            <span class="card-kpi-label">Transfers</span>
            <span class="card-kpi-value">${kpis.completedTransfers}/${kpis.totalTransfers}</span>
          </div>
          <div class="card-kpi">
            <span class="card-kpi-label">Avg Latency</span>
            <span class="card-kpi-value">${kpis.averageLatency.toFixed(0)}ms</span>
          </div>
          <div class="card-kpi">
            <span class="card-kpi-label">P50 Latency</span>
            <span class="card-kpi-value">${kpis.p50Latency.toFixed(0)}ms</span>
          </div>
          <div class="card-kpi">
            <span class="card-kpi-label">P95 Latency</span>
            <span class="card-kpi-value">${kpis.p95Latency.toFixed(0)}ms</span>
          </div>
          <div class="card-kpi">
            <span class="card-kpi-label">P99 Latency</span>
            <span class="card-kpi-value">${kpis.p99Latency.toFixed(0)}ms</span>
          </div>
          <div class="card-kpi">
            <span class="card-kpi-label">Rebalances</span>
            <span class="card-kpi-value">${kpis.totalRebalances}</span>
          </div>
          <div class="card-kpi">
            <span class="card-kpi-label">Rebal Volume</span>
            <span class="card-kpi-value">${formatVolume(kpis.rebalanceVolume)} tokens</span>
          </div>
          <div class="card-kpi">
            <span class="card-kpi-label">Gas Cost</span>
            <span class="card-kpi-value">${formatVolume(kpis.totalGasCost)} tokens</span>
          </div>
          <div class="card-kpi">
            <span class="card-kpi-label">Duration</span>
            <span class="card-kpi-value">${(r.duration / 1000).toFixed(1)}s</span>
          </div>
        </div>
      </div>`;
    })
    .join('');

  return `
    <h3>Strategy Details</h3>
    <div class="strategy-cards">${cards}
    </div>`;
}

function getStyles(): string {
  return `
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      color: #e0e0e0;
      padding: 20px;
      line-height: 1.6;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
    }

    .header-bar {
      background: #16213e;
      padding: 16px 24px;
      border-radius: 8px 8px 0 0;
      margin-bottom: 0;
    }

    .header-bar h1 {
      color: #fff;
      font-size: 1.5rem;
      margin: 0;
    }

    h2 {
      color: #e0e0e0;
      font-size: 1.25rem;
      padding: 12px 24px;
      background: #1e1e35;
      border-radius: 0 0 8px 8px;
      margin-bottom: 16px;
    }

    h3 {
      color: #fff;
      font-size: 1.1rem;
      margin: 24px 0 12px;
    }

    .description {
      color: #aaa;
      margin-bottom: 16px;
      font-size: 0.95rem;
    }

    .winner-banner {
      background: linear-gradient(135deg, #3d3400, #5a4e00);
      border: 1px solid #ffd700;
      color: #ffd700;
      padding: 14px 20px;
      border-radius: 8px;
      font-size: 1.05rem;
      margin-bottom: 20px;
    }

    .winner-banner strong {
      color: #fff;
    }

    /* Scorecard Table */
    .scorecard {
      width: 100%;
      border-collapse: collapse;
      background: #252542;
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 24px;
    }

    .scorecard thead {
      position: sticky;
      top: 0;
    }

    .scorecard th {
      background: #16213e;
      color: #aaa;
      text-transform: uppercase;
      font-size: 0.75rem;
      padding: 10px 12px;
      text-align: left;
      letter-spacing: 0.05em;
    }

    .scorecard td {
      padding: 10px 12px;
      font-size: 0.9rem;
      border-bottom: 1px solid #2a2a45;
    }

    .scorecard tbody tr:nth-child(even) {
      background: #1e1e35;
    }

    .scorecard tbody tr:nth-child(odd) {
      background: #252542;
    }

    .scorecard tbody tr.winner-row {
      background: rgba(255, 215, 0, 0.1);
    }

    .scorecard tbody tr.winner-row td {
      border-bottom-color: rgba(255, 215, 0, 0.3);
    }

    .color-dot {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-right: 8px;
      vertical-align: middle;
    }

    /* KPI Bar Charts */
    .kpi-bars {
      background: #252542;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 24px;
    }

    .bar-group {
      margin-bottom: 20px;
    }

    .bar-group:last-child {
      margin-bottom: 0;
    }

    .bar-label {
      font-size: 0.85rem;
      color: #aaa;
      text-transform: uppercase;
      margin-bottom: 8px;
      letter-spacing: 0.04em;
    }

    .bar-row {
      display: flex;
      align-items: center;
      margin-bottom: 6px;
    }

    .bar-name {
      width: 160px;
      min-width: 160px;
      font-size: 0.85rem;
      color: #ccc;
      text-align: right;
      padding-right: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .bar-track {
      flex: 1;
      height: 26px;
      background: #1a1a2e;
      border-radius: 4px;
      overflow: hidden;
    }

    .bar-fill {
      height: 100%;
      border-radius: 4px;
      display: flex;
      align-items: center;
      padding-left: 8px;
      font-size: 0.8rem;
      color: #fff;
      font-weight: 600;
      white-space: nowrap;
      min-width: fit-content;
      transition: width 0.3s ease;
    }

    /* Strategy Cards */
    .strategy-cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }

    .strategy-card {
      background: #252542;
      border-radius: 8px;
      overflow: hidden;
    }

    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: #1e1e35;
    }

    .card-header h4 {
      color: #fff;
      font-size: 0.95rem;
      margin: 0;
    }

    .strategy-badge {
      font-size: 0.7rem;
      padding: 3px 8px;
      color: #fff;
      border-radius: 4px;
      text-transform: uppercase;
    }

    .card-body {
      padding: 12px 16px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }

    .card-kpi {
      display: flex;
      flex-direction: column;
    }

    .card-kpi-label {
      font-size: 0.7rem;
      color: #888;
      text-transform: uppercase;
    }

    .card-kpi-value {
      font-size: 1rem;
      font-weight: bold;
      color: #4ecdc4;
    }
  `;
}
