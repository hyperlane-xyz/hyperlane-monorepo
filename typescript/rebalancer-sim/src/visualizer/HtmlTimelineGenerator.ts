import type { SimulationResult } from '../kpi/types.js';

import type { HtmlGeneratorOptions } from './types.js';
import { toVisualizationData } from './types.js';

const DEFAULT_OPTIONS: Required<HtmlGeneratorOptions> = {
  width: 1200,
  rowHeight: 120,
  showBalances: true,
  showRebalances: true,
  title: '',
};

/**
 * Generate a standalone HTML timeline visualization
 */
export function generateTimelineHtml(
  results: SimulationResult[],
  options: HtmlGeneratorOptions = {},
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const visualizations = results.map(toVisualizationData);
  const title =
    opts.title || `Simulation: ${visualizations[0]?.scenario || 'Unknown'}`;

  // Serialize data for embedding (handle BigInt)
  const serializedData = JSON.stringify(
    visualizations,
    (_, value) => (typeof value === 'bigint' ? value.toString() : value),
    2,
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
${getStyles(opts)}
  </style>
</head>
<body>
  <div class="container">
    <h1>${escapeHtml(title)}</h1>
    <div id="kpi-summary"></div>
    <div id="timeline-container"></div>
    <div id="legend"></div>
    <div id="details-panel"></div>
  </div>

  <script>
${getScript(opts)}

// Embedded simulation data
const simulationData = ${serializedData};

// Render on load
document.addEventListener('DOMContentLoaded', () => {
  renderVisualization(simulationData);
});
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getStyles(opts: Required<HtmlGeneratorOptions>): string {
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
      max-width: ${opts.width + 100}px;
      margin: 0 auto;
    }

    h1 {
      margin-bottom: 20px;
      color: #fff;
      font-size: 1.5rem;
    }

    h2 {
      margin: 20px 0 10px;
      color: #ccc;
      font-size: 1.1rem;
    }

    #kpi-summary {
      display: flex;
      gap: 20px;
      flex-wrap: wrap;
      margin-bottom: 30px;
    }

    .kpi-card {
      background: #252542;
      padding: 15px 20px;
      border-radius: 8px;
      min-width: 150px;
    }

    .kpi-card .label {
      font-size: 0.8rem;
      color: #888;
      text-transform: uppercase;
    }

    .kpi-card .value {
      font-size: 1.5rem;
      font-weight: bold;
      color: #4ecdc4;
    }

    .kpi-card.warning .value {
      color: #f9c74f;
    }

    .kpi-card.error .value {
      color: #f94144;
    }

    .rebalancer-section {
      margin-bottom: 40px;
      background: #252542;
      border-radius: 8px;
      padding: 20px;
    }

    .rebalancer-title {
      font-size: 1.2rem;
      margin-bottom: 15px;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .rebalancer-badge {
      font-size: 0.7rem;
      padding: 3px 8px;
      background: #4ecdc4;
      color: #1a1a2e;
      border-radius: 4px;
    }

    .timeline-svg {
      background: #1e1e30;
      border-radius: 8px;
      overflow: visible;
    }

    .chain-row {
      stroke: #333;
    }

    .chain-label {
      font-size: 12px;
      fill: #888;
      font-family: monospace;
    }

    .time-axis text {
      font-size: 10px;
      fill: #666;
    }

    .time-axis line {
      stroke: #333;
    }

    .transfer-bar {
      cursor: pointer;
      transition: opacity 0.2s;
    }

    .transfer-bar:hover {
      opacity: 0.8;
    }

    .transfer-bar.completed {
      fill: #4ecdc4;
    }

    .transfer-bar.failed {
      fill: #f94144;
    }

    .transfer-bar.pending {
      fill: #f9c74f;
    }

    .rebalance-marker {
      cursor: pointer;
    }

    .rebalance-marker circle {
      fill: #9b59b6;
      stroke: #fff;
      stroke-width: 1;
    }

    .rebalance-arrow {
      stroke: #9b59b6;
      stroke-width: 2;
      stroke-dasharray: 4,2;
      marker-end: url(#arrowhead);
    }

    .balance-line {
      fill: none;
      stroke-width: 1.5;
      opacity: 0.6;
    }

    .balance-area {
      opacity: 0.1;
    }

    #legend {
      display: flex;
      gap: 20px;
      margin-top: 20px;
      flex-wrap: wrap;
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.85rem;
    }

    .legend-color {
      width: 20px;
      height: 12px;
      border-radius: 2px;
    }

    #details-panel {
      margin-top: 20px;
      padding: 15px;
      background: #252542;
      border-radius: 8px;
      min-height: 100px;
      display: none;
    }

    #details-panel.visible {
      display: block;
    }

    #details-panel h3 {
      margin-bottom: 10px;
      color: #fff;
    }

    #details-panel .detail-row {
      display: flex;
      gap: 10px;
      margin: 5px 0;
    }

    #details-panel .detail-label {
      color: #888;
      min-width: 100px;
    }

    #details-panel .detail-value {
      color: #fff;
      font-family: monospace;
    }

    .tooltip {
      position: absolute;
      background: #333;
      color: #fff;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 12px;
      pointer-events: none;
      z-index: 1000;
      max-width: 300px;
    }
  `;
}

function getScript(opts: Required<HtmlGeneratorOptions>): string {
  return `
const WIDTH = ${opts.width};
const ROW_HEIGHT = ${opts.rowHeight};
const SHOW_BALANCES = ${opts.showBalances};
const SHOW_REBALANCES = ${opts.showRebalances};
const MARGIN = { top: 40, right: 20, bottom: 30, left: 80 };
const CHAIN_COLORS = ['#4ecdc4', '#f9c74f', '#f94144', '#90be6d', '#577590', '#9b59b6'];

function renderVisualization(data) {
  const container = document.getElementById('timeline-container');
  const kpiSummary = document.getElementById('kpi-summary');
  const legend = document.getElementById('legend');

  // Render each rebalancer's results
  data.forEach((viz, index) => {
    // Create section
    const section = document.createElement('div');
    section.className = 'rebalancer-section';
    section.innerHTML = '<div class="rebalancer-title">' +
      '<span>' + viz.rebalancerName + '</span>' +
      '<span class="rebalancer-badge">Rebalancer ' + (index + 1) + '</span>' +
      '</div>';

    // KPI summary for this rebalancer
    const kpis = renderKPIs(viz);
    section.appendChild(kpis);

    // Timeline SVG
    const svg = renderTimeline(viz, index);
    section.appendChild(svg);

    container.appendChild(section);
  });

  // Legend
  legend.innerHTML = \`
    <div class="legend-item">
      <div class="legend-color" style="background: #4ecdc4"></div>
      <span>Completed Transfer</span>
    </div>
    <div class="legend-item">
      <div class="legend-color" style="background: #f94144"></div>
      <span>Failed Transfer</span>
    </div>
    <div class="legend-item">
      <div class="legend-color" style="background: #f9c74f"></div>
      <span>Pending Transfer</span>
    </div>
    <div class="legend-item">
      <div class="legend-color" style="background: #9b59b6"></div>
      <span>Rebalance</span>
    </div>
  \`;
}

function renderKPIs(viz) {
  const kpis = viz.kpis;
  const div = document.createElement('div');
  div.style.display = 'flex';
  div.style.gap = '15px';
  div.style.marginBottom = '15px';
  div.style.flexWrap = 'wrap';

  const completionClass = kpis.completionRate < 0.95 ? 'warning' : '';
  const latencyClass = kpis.p95Latency > 1000 ? 'warning' : '';

  div.innerHTML = \`
    <div class="kpi-card \${completionClass}">
      <div class="label">Completion</div>
      <div class="value">\${(kpis.completionRate * 100).toFixed(1)}%</div>
    </div>
    <div class="kpi-card">
      <div class="label">Transfers</div>
      <div class="value">\${kpis.completedTransfers}/\${kpis.totalTransfers}</div>
    </div>
    <div class="kpi-card \${latencyClass}">
      <div class="label">Avg Latency</div>
      <div class="value">\${kpis.averageLatency.toFixed(0)}ms</div>
    </div>
    <div class="kpi-card">
      <div class="label">P95 Latency</div>
      <div class="value">\${kpis.p95Latency.toFixed(0)}ms</div>
    </div>
    <div class="kpi-card">
      <div class="label">Rebalances</div>
      <div class="value">\${kpis.totalRebalances}</div>
    </div>
  \`;

  return div;
}

function renderTimeline(viz, vizIndex) {
  const chains = viz.chains;
  const height = MARGIN.top + chains.length * ROW_HEIGHT + MARGIN.bottom;
  const innerWidth = WIDTH - MARGIN.left - MARGIN.right;
  const innerHeight = height - MARGIN.top - MARGIN.bottom;

  // Time scale
  const timeExtent = [viz.startTime, viz.endTime];
  const xScale = (t) => MARGIN.left + ((t - timeExtent[0]) / (timeExtent[1] - timeExtent[0])) * innerWidth;

  // Chain scale
  const yScale = (chain) => MARGIN.top + chains.indexOf(chain) * ROW_HEIGHT + ROW_HEIGHT / 2;

  // Create SVG
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'timeline-svg');
  svg.setAttribute('width', WIDTH);
  svg.setAttribute('height', height);

  // Defs for arrow marker
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = \`
    <marker id="arrowhead-\${vizIndex}" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
      <polygon points="0 0, 10 3.5, 0 7" fill="#9b59b6"/>
    </marker>
  \`;
  svg.appendChild(defs);

  // Background grid
  chains.forEach((chain, i) => {
    const y = MARGIN.top + i * ROW_HEIGHT;

    // Row background
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', MARGIN.left);
    rect.setAttribute('y', y);
    rect.setAttribute('width', innerWidth);
    rect.setAttribute('height', ROW_HEIGHT);
    rect.setAttribute('fill', i % 2 === 0 ? '#1e1e30' : '#222240');
    svg.appendChild(rect);

    // Chain label
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('class', 'chain-label');
    text.setAttribute('x', MARGIN.left - 10);
    text.setAttribute('y', y + ROW_HEIGHT / 2 + 4);
    text.setAttribute('text-anchor', 'end');
    text.textContent = chain;
    svg.appendChild(text);
  });

  // Time axis
  const tickCount = 10;
  const tickStep = (timeExtent[1] - timeExtent[0]) / tickCount;
  for (let i = 0; i <= tickCount; i++) {
    const t = timeExtent[0] + i * tickStep;
    const x = xScale(t);

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('class', 'time-axis');
    line.setAttribute('x1', x);
    line.setAttribute('y1', MARGIN.top);
    line.setAttribute('x2', x);
    line.setAttribute('y2', height - MARGIN.bottom);
    line.setAttribute('stroke', '#333');
    line.setAttribute('stroke-dasharray', '2,2');
    svg.appendChild(line);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('class', 'time-axis');
    text.setAttribute('x', x);
    text.setAttribute('y', height - 10);
    text.setAttribute('text-anchor', 'middle');
    text.textContent = ((t - timeExtent[0]) / 1000).toFixed(1) + 's';
    svg.appendChild(text);
  }

  // Balance curves (if enabled and data available)
  if (SHOW_BALANCES && viz.balanceTimeline.length > 0) {
    renderBalanceCurves(svg, viz, xScale, chains, innerWidth);
  }

  // Transfer bars
  viz.transfers.forEach((transfer) => {
    const startX = xScale(transfer.startTime);
    const endX = transfer.endTime ? xScale(transfer.endTime) : xScale(viz.endTime);
    const y = yScale(transfer.origin);
    const barHeight = 8;

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('class', 'transfer-bar ' + transfer.status);
    rect.setAttribute('x', startX);
    rect.setAttribute('y', y - barHeight / 2);
    rect.setAttribute('width', Math.max(endX - startX, 3));
    rect.setAttribute('height', barHeight);
    rect.setAttribute('rx', 2);

    // Tooltip
    rect.addEventListener('mouseenter', (e) => showTooltip(e, transfer));
    rect.addEventListener('mouseleave', hideTooltip);
    rect.addEventListener('click', () => showDetails(transfer, 'transfer'));

    svg.appendChild(rect);

    // Arrow to destination if completed
    if (transfer.status === 'completed' && transfer.endTime) {
      const destY = yScale(transfer.destination);
      if (destY !== y) {
        const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        arrow.setAttribute('x1', endX);
        arrow.setAttribute('y1', y);
        arrow.setAttribute('x2', endX);
        arrow.setAttribute('y2', destY);
        arrow.setAttribute('stroke', '#4ecdc4');
        arrow.setAttribute('stroke-width', '1');
        arrow.setAttribute('stroke-dasharray', '3,2');
        arrow.setAttribute('opacity', '0.5');
        svg.appendChild(arrow);
      }
    }
  });

  // Rebalance markers (if enabled)
  if (SHOW_REBALANCES) {
    viz.rebalances.forEach((rebalance) => {
      const x = xScale(rebalance.timestamp);
      const originY = yScale(rebalance.origin);
      const destY = yScale(rebalance.destination);

      // Arrow from origin to destination
      const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      arrow.setAttribute('class', 'rebalance-arrow');
      arrow.setAttribute('x1', x);
      arrow.setAttribute('y1', originY);
      arrow.setAttribute('x2', x);
      arrow.setAttribute('y2', destY > originY ? destY - 8 : destY + 8);
      arrow.setAttribute('marker-end', 'url(#arrowhead-' + vizIndex + ')');
      svg.appendChild(arrow);

      // Circle marker at origin
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'rebalance-marker');

      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', x);
      circle.setAttribute('cy', originY);
      circle.setAttribute('r', 5);
      g.appendChild(circle);

      g.addEventListener('mouseenter', (e) => showTooltip(e, rebalance, 'rebalance'));
      g.addEventListener('mouseleave', hideTooltip);
      g.addEventListener('click', () => showDetails(rebalance, 'rebalance'));

      svg.appendChild(g);
    });
  }

  return svg;
}

function renderBalanceCurves(svg, viz, xScale, chains, innerWidth) {
  const timeline = viz.balanceTimeline;
  if (timeline.length < 2) return;

  // Find max balance for scaling
  let maxBalance = 0n;
  timeline.forEach(snapshot => {
    Object.values(snapshot.balances).forEach(b => {
      const bal = BigInt(b);
      if (bal > maxBalance) maxBalance = bal;
    });
  });

  if (maxBalance === 0n) return;

  chains.forEach((chain, chainIndex) => {
    const chainY = MARGIN.top + chainIndex * ROW_HEIGHT;
    const curveHeight = ROW_HEIGHT * 0.4;
    const baseY = chainY + ROW_HEIGHT - 10;

    // Build path data
    const points = timeline.map(snapshot => {
      const x = xScale(snapshot.timestamp);
      const balance = BigInt(snapshot.balances[chain] || '0');
      const y = baseY - (Number(balance * BigInt(Math.floor(curveHeight))) / Number(maxBalance));
      return { x, y };
    });

    // Line path
    const pathD = points.map((p, i) => (i === 0 ? 'M' : 'L') + p.x + ',' + p.y).join(' ');

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'balance-line');
    path.setAttribute('d', pathD);
    path.setAttribute('stroke', CHAIN_COLORS[chainIndex % CHAIN_COLORS.length]);
    svg.appendChild(path);

    // Area fill
    const areaD = pathD + ' L' + points[points.length-1].x + ',' + baseY + ' L' + points[0].x + ',' + baseY + ' Z';
    const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    area.setAttribute('class', 'balance-area');
    area.setAttribute('d', areaD);
    area.setAttribute('fill', CHAIN_COLORS[chainIndex % CHAIN_COLORS.length]);
    svg.appendChild(area);
  });
}

let tooltipEl = null;

function showTooltip(event, data, type = 'transfer') {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'tooltip';
    document.body.appendChild(tooltipEl);
  }

  let content = '';
  if (type === 'transfer') {
    const latency = data.latency ? data.latency + 'ms' : 'pending';
    content = \`
      <strong>Transfer \${data.id}</strong><br>
      \${data.origin} → \${data.destination}<br>
      Amount: \${formatAmount(data.amount)}<br>
      Latency: \${latency}<br>
      Status: \${data.status}
    \`;
  } else {
    content = \`
      <strong>Rebalance \${data.id}</strong><br>
      \${data.origin} → \${data.destination}<br>
      Amount: \${formatAmount(data.amount)}<br>
      Success: \${data.success ? 'Yes' : 'No'}
    \`;
  }

  tooltipEl.innerHTML = content;
  tooltipEl.style.left = (event.pageX + 10) + 'px';
  tooltipEl.style.top = (event.pageY + 10) + 'px';
  tooltipEl.style.display = 'block';
}

function hideTooltip() {
  if (tooltipEl) {
    tooltipEl.style.display = 'none';
  }
}

function showDetails(data, type) {
  const panel = document.getElementById('details-panel');
  panel.classList.add('visible');

  let html = '';
  if (type === 'transfer') {
    html = \`
      <h3>Transfer Details</h3>
      <div class="detail-row"><span class="detail-label">ID:</span><span class="detail-value">\${data.id}</span></div>
      <div class="detail-row"><span class="detail-label">Route:</span><span class="detail-value">\${data.origin} → \${data.destination}</span></div>
      <div class="detail-row"><span class="detail-label">Amount:</span><span class="detail-value">\${formatAmount(data.amount)}</span></div>
      <div class="detail-row"><span class="detail-label">Start:</span><span class="detail-value">\${new Date(data.startTime).toISOString()}</span></div>
      <div class="detail-row"><span class="detail-label">End:</span><span class="detail-value">\${data.endTime ? new Date(data.endTime).toISOString() : 'N/A'}</span></div>
      <div class="detail-row"><span class="detail-label">Latency:</span><span class="detail-value">\${data.latency ? data.latency + 'ms' : 'N/A'}</span></div>
      <div class="detail-row"><span class="detail-label">Status:</span><span class="detail-value">\${data.status}</span></div>
    \`;
  } else {
    html = \`
      <h3>Rebalance Details</h3>
      <div class="detail-row"><span class="detail-label">ID:</span><span class="detail-value">\${data.id}</span></div>
      <div class="detail-row"><span class="detail-label">Route:</span><span class="detail-value">\${data.origin} → \${data.destination}</span></div>
      <div class="detail-row"><span class="detail-label">Amount:</span><span class="detail-value">\${formatAmount(data.amount)}</span></div>
      <div class="detail-row"><span class="detail-label">Time:</span><span class="detail-value">\${new Date(data.timestamp).toISOString()}</span></div>
      <div class="detail-row"><span class="detail-label">Gas Cost:</span><span class="detail-value">\${formatAmount(data.gasCost)}</span></div>
      <div class="detail-row"><span class="detail-label">Success:</span><span class="detail-value">\${data.success ? 'Yes' : 'No'}</span></div>
    \`;
  }

  panel.innerHTML = html;
}

function formatAmount(amount) {
  const val = BigInt(amount);
  const eth = Number(val) / 1e18;
  if (eth >= 1) return eth.toFixed(4) + ' ETH';
  if (eth >= 0.001) return (eth * 1000).toFixed(4) + ' mETH';
  return val.toString() + ' wei';
}
  `;
}
