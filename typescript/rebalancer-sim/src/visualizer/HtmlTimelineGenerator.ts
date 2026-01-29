import type { SimulationResult } from '../kpi/types.js';

import type { HtmlGeneratorOptions } from './types.js';
import { toVisualizationData } from './types.js';

const DEFAULT_OPTIONS: Required<HtmlGeneratorOptions> = {
  width: 1200,
  rowHeight: 150,
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
      max-width: ${opts.width + 150}px;
      margin: 0 auto;
    }

    h1 {
      margin-bottom: 20px;
      color: #fff;
      font-size: 1.5rem;
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

    .kpi-row {
      display: flex;
      gap: 15px;
      margin-bottom: 15px;
      flex-wrap: wrap;
    }

    .kpi-card {
      background: #1e1e30;
      padding: 12px 16px;
      border-radius: 6px;
      min-width: 120px;
    }

    .kpi-card .label {
      font-size: 0.75rem;
      color: #888;
      text-transform: uppercase;
    }

    .kpi-card .value {
      font-size: 1.3rem;
      font-weight: bold;
      color: #4ecdc4;
    }

    .kpi-card.warning .value {
      color: #f9c74f;
    }

    .timeline-wrapper {
      position: relative;
      margin-top: 20px;
    }

    .timeline-svg {
      background: #1e1e30;
      border-radius: 8px;
      display: block;
    }

    .chain-label {
      font-size: 12px;
      fill: #aaa;
      font-family: monospace;
      font-weight: bold;
    }

    .balance-label {
      font-size: 9px;
      fill: #666;
      font-family: monospace;
    }

    .time-axis-label {
      font-size: 10px;
      fill: #666;
    }

    .transfer-group {
      cursor: pointer;
    }

    .transfer-group:hover .transfer-bar {
      filter: brightness(1.2);
    }

    .transfer-bar {
      transition: filter 0.2s;
    }

    .transfer-label {
      font-size: 10px;
      fill: #fff;
      font-weight: bold;
      pointer-events: none;
    }

    .transfer-time-label {
      font-size: 8px;
      fill: #888;
      font-family: monospace;
    }

    .start-marker {
      fill: #fff;
      stroke: none;
    }

    .end-marker {
      stroke-width: 2;
    }

    .rebalance-marker {
      cursor: pointer;
    }

    .rebalance-arrow {
      stroke-width: 2;
      stroke-dasharray: 4,2;
    }

    .balance-line {
      fill: none;
      stroke-width: 2;
      opacity: 0.7;
    }

    .balance-area {
      opacity: 0.15;
    }

    #legend {
      display: flex;
      gap: 25px;
      margin-top: 20px;
      flex-wrap: wrap;
      padding: 15px;
      background: #252542;
      border-radius: 8px;
    }

    .legend-section {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .legend-title {
      font-size: 0.75rem;
      color: #888;
      text-transform: uppercase;
      margin-bottom: 4px;
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.85rem;
    }

    .legend-color {
      width: 24px;
      height: 12px;
      border-radius: 2px;
    }

    .legend-line {
      width: 24px;
      height: 3px;
      border-radius: 1px;
    }

    .legend-marker {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }

    #details-panel {
      margin-top: 20px;
      padding: 15px;
      background: #252542;
      border-radius: 8px;
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
      background: rgba(30, 30, 48, 0.95);
      color: #fff;
      padding: 10px 14px;
      border-radius: 6px;
      font-size: 12px;
      pointer-events: none;
      z-index: 1000;
      max-width: 300px;
      border: 1px solid #444;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }

    .tooltip strong {
      color: #4ecdc4;
    }
  `;
}

function getScript(opts: Required<HtmlGeneratorOptions>): string {
  return `
const WIDTH = ${opts.width};
const ROW_HEIGHT = ${opts.rowHeight};
const SHOW_BALANCES = ${opts.showBalances};
const SHOW_REBALANCES = ${opts.showRebalances};
const MARGIN = { top: 50, right: 30, bottom: 40, left: 100 };

// Distinct colors for transfers (T1, T2, T3, etc.)
const TRANSFER_COLORS = [
  '#00b4d8', // cyan
  '#06d6a0', // green
  '#ffd166', // yellow
  '#ef476f', // pink
  '#118ab2', // blue
  '#073b4c', // dark blue
  '#e76f51', // orange
  '#2a9d8f', // teal
];

// Colors for balance curves per chain
const CHAIN_COLORS = {
  chain1: '#f9c74f',  // yellow/gold
  chain2: '#4ecdc4',  // teal
  chain3: '#f94144',  // red
  chain4: '#90be6d',  // green
  chain5: '#577590',  // blue-gray
};

const REBALANCE_COLOR = '#9b59b6';  // purple

function renderVisualization(data) {
  const container = document.getElementById('timeline-container');
  const legend = document.getElementById('legend');

  // Render each rebalancer's results
  data.forEach((viz, index) => {
    const section = document.createElement('div');
    section.className = 'rebalancer-section';

    // Title
    const titleDiv = document.createElement('div');
    titleDiv.className = 'rebalancer-title';
    titleDiv.innerHTML = '<span>' + viz.rebalancerName + '</span>' +
      '<span class="rebalancer-badge">Rebalancer ' + (index + 1) + '</span>';
    section.appendChild(titleDiv);

    // KPIs
    section.appendChild(renderKPIs(viz));

    // Timeline SVG
    section.appendChild(renderTimeline(viz, index));

    container.appendChild(section);
  });

  // Legend
  renderLegend(legend, data[0]);
}

function renderKPIs(viz) {
  const kpis = viz.kpis;
  const div = document.createElement('div');
  div.className = 'kpi-row';

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

  // Time scale
  const timeExtent = [viz.startTime, viz.endTime];
  const duration = timeExtent[1] - timeExtent[0];
  const xScale = (t) => MARGIN.left + ((t - timeExtent[0]) / duration) * innerWidth;

  // Create SVG
  const wrapper = document.createElement('div');
  wrapper.className = 'timeline-wrapper';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'timeline-svg');
  svg.setAttribute('width', WIDTH);
  svg.setAttribute('height', height);

  // Defs for markers
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = \`
    <marker id="rebalance-arrow-\${vizIndex}" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" fill="\${REBALANCE_COLOR}"/>
    </marker>
  \`;
  svg.appendChild(defs);

  // Background and chain rows
  chains.forEach((chain, i) => {
    const y = MARGIN.top + i * ROW_HEIGHT;

    // Row background
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', MARGIN.left);
    rect.setAttribute('y', y);
    rect.setAttribute('width', innerWidth);
    rect.setAttribute('height', ROW_HEIGHT);
    rect.setAttribute('fill', i % 2 === 0 ? '#1a1a2e' : '#1e1e35');
    svg.appendChild(rect);

    // Chain label
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('class', 'chain-label');
    text.setAttribute('x', MARGIN.left - 15);
    text.setAttribute('y', y + ROW_HEIGHT / 2 + 4);
    text.setAttribute('text-anchor', 'end');
    text.textContent = chain;
    svg.appendChild(text);

    // Horizontal line at center of row
    const centerLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    centerLine.setAttribute('x1', MARGIN.left);
    centerLine.setAttribute('y1', y + ROW_HEIGHT / 2);
    centerLine.setAttribute('x2', MARGIN.left + innerWidth);
    centerLine.setAttribute('y2', y + ROW_HEIGHT / 2);
    centerLine.setAttribute('stroke', '#333');
    centerLine.setAttribute('stroke-width', '1');
    svg.appendChild(centerLine);
  });

  // Time axis
  const tickCount = Math.min(10, Math.ceil(duration / 500));
  for (let i = 0; i <= tickCount; i++) {
    const t = timeExtent[0] + (i / tickCount) * duration;
    const x = xScale(t);

    // Vertical grid line
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x);
    line.setAttribute('y1', MARGIN.top);
    line.setAttribute('x2', x);
    line.setAttribute('y2', height - MARGIN.bottom);
    line.setAttribute('stroke', '#2a2a45');
    line.setAttribute('stroke-width', '1');
    svg.appendChild(line);

    // Time label
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('class', 'time-axis-label');
    text.setAttribute('x', x);
    text.setAttribute('y', height - 15);
    text.setAttribute('text-anchor', 'middle');
    text.textContent = ((t - timeExtent[0]) / 1000).toFixed(1) + 's';
    svg.appendChild(text);
  }

  // Balance curves (render first, behind transfers)
  if (SHOW_BALANCES && viz.balanceTimeline.length > 0) {
    renderBalanceCurves(svg, viz, xScale, chains);
  }

  // Group transfers by origin chain for vertical stacking
  const transfersByChain = {};
  chains.forEach(c => transfersByChain[c] = []);
  viz.transfers.forEach((t, i) => {
    t._index = i;  // Store original index for coloring
    if (transfersByChain[t.origin]) {
      transfersByChain[t.origin].push(t);
    }
  });

  // Render transfers with distinct colors and labels
  chains.forEach((chain, chainIndex) => {
    const chainY = MARGIN.top + chainIndex * ROW_HEIGHT;
    const transfers = transfersByChain[chain] || [];
    const barHeight = 16;
    const barSpacing = 20;
    const startY = chainY + ROW_HEIGHT / 2 - ((transfers.length - 1) * barSpacing) / 2;

    transfers.forEach((transfer, stackIndex) => {
      const color = TRANSFER_COLORS[transfer._index % TRANSFER_COLORS.length];
      const y = startY + stackIndex * barSpacing;
      const startX = xScale(transfer.startTime);
      const endX = transfer.endTime ? xScale(transfer.endTime) : xScale(viz.endTime);
      const width = Math.max(endX - startX, 20);

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'transfer-group');

      // Transfer bar
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('class', 'transfer-bar');
      rect.setAttribute('x', startX);
      rect.setAttribute('y', y - barHeight / 2);
      rect.setAttribute('width', width);
      rect.setAttribute('height', barHeight);
      rect.setAttribute('rx', 3);
      rect.setAttribute('fill', color);
      if (transfer.status === 'failed') {
        rect.setAttribute('fill', '#f94144');
        rect.setAttribute('opacity', '0.7');
      } else if (transfer.status === 'pending') {
        rect.setAttribute('fill', color);
        rect.setAttribute('opacity', '0.5');
        rect.setAttribute('stroke', color);
        rect.setAttribute('stroke-width', '2');
        rect.setAttribute('stroke-dasharray', '4,2');
      }
      g.appendChild(rect);

      // Start marker (circle)
      const startCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      startCircle.setAttribute('class', 'start-marker');
      startCircle.setAttribute('cx', startX);
      startCircle.setAttribute('cy', y);
      startCircle.setAttribute('r', 4);
      startCircle.setAttribute('fill', '#fff');
      g.appendChild(startCircle);

      // End marker (diamond) if completed
      if (transfer.status === 'completed' && transfer.endTime) {
        const endMarker = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        endMarker.setAttribute('class', 'end-marker');
        const ex = endX;
        const ey = y;
        const s = 5;
        endMarker.setAttribute('points', \`\${ex},\${ey-s} \${ex+s},\${ey} \${ex},\${ey+s} \${ex-s},\${ey}\`);
        endMarker.setAttribute('fill', color);
        endMarker.setAttribute('stroke', '#fff');
        g.appendChild(endMarker);
      }

      // Transfer ID label inside bar
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('class', 'transfer-label');
      label.setAttribute('x', startX + 6);
      label.setAttribute('y', y + 4);
      label.textContent = 'T' + (transfer._index + 1);
      g.appendChild(label);

      // Latency label above bar
      if (transfer.latency) {
        const latencyLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        latencyLabel.setAttribute('class', 'transfer-time-label');
        latencyLabel.setAttribute('x', startX + width / 2);
        latencyLabel.setAttribute('y', y - barHeight / 2 - 3);
        latencyLabel.setAttribute('text-anchor', 'middle');
        latencyLabel.textContent = transfer.latency + 'ms';
        g.appendChild(latencyLabel);
      }

      // Arrow to destination
      if (transfer.status === 'completed' && transfer.endTime) {
        const destChainIndex = chains.indexOf(transfer.destination);
        if (destChainIndex !== -1 && destChainIndex !== chainIndex) {
          const destY = MARGIN.top + destChainIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
          const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          arrow.setAttribute('x1', endX);
          arrow.setAttribute('y1', y);
          arrow.setAttribute('x2', endX);
          arrow.setAttribute('y2', destY > y ? destY - 10 : destY + 10);
          arrow.setAttribute('stroke', color);
          arrow.setAttribute('stroke-width', '2');
          arrow.setAttribute('stroke-dasharray', '4,3');
          arrow.setAttribute('opacity', '0.6');
          g.appendChild(arrow);

          // Arrow head at destination
          const arrowHead = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
          const ay = destY > y ? destY - 10 : destY + 10;
          const dir = destY > y ? 1 : -1;
          arrowHead.setAttribute('points', \`\${endX-4},\${ay} \${endX+4},\${ay} \${endX},\${ay + dir * 8}\`);
          arrowHead.setAttribute('fill', color);
          arrowHead.setAttribute('opacity', '0.6');
          g.appendChild(arrowHead);
        }
      }

      // Event handlers
      g.addEventListener('mouseenter', (e) => showTooltip(e, transfer, 'transfer'));
      g.addEventListener('mouseleave', hideTooltip);
      g.addEventListener('click', () => showDetails(transfer, 'transfer'));

      svg.appendChild(g);
    });
  });

  // Rebalance bars (similar to transfers but with distinct styling)
  if (SHOW_REBALANCES) {
    // Group rebalances by origin chain for vertical stacking
    const rebalancesByChain = {};
    chains.forEach(c => rebalancesByChain[c] = []);
    viz.rebalances.forEach((r, i) => {
      r._index = i;
      if (rebalancesByChain[r.origin]) {
        rebalancesByChain[r.origin].push(r);
      }
    });

    chains.forEach((chain, chainIndex) => {
      const chainY = MARGIN.top + chainIndex * ROW_HEIGHT;
      const rebalances = rebalancesByChain[chain] || [];
      const barHeight = 12;
      const barSpacing = 16;
      // Position rebalances below center line (transfers above)
      const startY = chainY + ROW_HEIGHT / 2 + 20 + ((rebalances.length - 1) * barSpacing) / 2;

      rebalances.forEach((rebalance, stackIndex) => {
        const y = startY - stackIndex * barSpacing;
        const startX = xScale(rebalance.startTime);
        const endX = rebalance.endTime ? xScale(rebalance.endTime) : xScale(viz.endTime);
        const width = Math.max(endX - startX, 20);

        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('class', 'rebalance-marker');

        // Rebalance bar
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', startX);
        rect.setAttribute('y', y - barHeight / 2);
        rect.setAttribute('width', width);
        rect.setAttribute('height', barHeight);
        rect.setAttribute('rx', 2);
        rect.setAttribute('fill', REBALANCE_COLOR);
        if (rebalance.status === 'failed') {
          rect.setAttribute('fill', '#f94144');
          rect.setAttribute('opacity', '0.7');
        } else if (rebalance.status === 'pending') {
          rect.setAttribute('opacity', '0.5');
          rect.setAttribute('stroke', REBALANCE_COLOR);
          rect.setAttribute('stroke-width', '2');
          rect.setAttribute('stroke-dasharray', '4,2');
        }
        g.appendChild(rect);

        // Start marker (small circle)
        const startCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        startCircle.setAttribute('cx', startX);
        startCircle.setAttribute('cy', y);
        startCircle.setAttribute('r', 3);
        startCircle.setAttribute('fill', '#fff');
        g.appendChild(startCircle);

        // End marker (diamond) if completed
        if (rebalance.status === 'completed' && rebalance.endTime) {
          const endMarker = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
          const ex = endX;
          const ey = y;
          const s = 4;
          endMarker.setAttribute('points', \`\${ex},\${ey-s} \${ex+s},\${ey} \${ex},\${ey+s} \${ex-s},\${ey}\`);
          endMarker.setAttribute('fill', REBALANCE_COLOR);
          endMarker.setAttribute('stroke', '#fff');
          g.appendChild(endMarker);
        }

        // R label inside bar
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', startX + 5);
        label.setAttribute('y', y + 3);
        label.setAttribute('fill', '#fff');
        label.setAttribute('font-size', '8');
        label.setAttribute('font-weight', 'bold');
        label.textContent = 'R' + (rebalance._index + 1);
        g.appendChild(label);

        // Latency label above bar
        if (rebalance.latency) {
          const latencyLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          latencyLabel.setAttribute('class', 'transfer-time-label');
          latencyLabel.setAttribute('x', startX + width / 2);
          latencyLabel.setAttribute('y', y - barHeight / 2 - 3);
          latencyLabel.setAttribute('text-anchor', 'middle');
          latencyLabel.textContent = rebalance.latency + 'ms';
          g.appendChild(latencyLabel);
        }

        // Arrow to destination chain
        const destChainIndex = chains.indexOf(rebalance.destination);
        if (destChainIndex !== -1 && destChainIndex !== chainIndex && rebalance.endTime) {
          const destY = MARGIN.top + destChainIndex * ROW_HEIGHT + ROW_HEIGHT / 2 + 20;
          const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          arrow.setAttribute('class', 'rebalance-arrow');
          arrow.setAttribute('x1', endX);
          arrow.setAttribute('y1', y);
          arrow.setAttribute('x2', endX);
          arrow.setAttribute('y2', destY > y ? destY - 10 : destY + 10);
          arrow.setAttribute('stroke', REBALANCE_COLOR);
          arrow.setAttribute('marker-end', 'url(#rebalance-arrow-' + vizIndex + ')');
          g.appendChild(arrow);
        }

        g.addEventListener('mouseenter', (e) => showTooltip(e, rebalance, 'rebalance'));
        g.addEventListener('mouseleave', hideTooltip);
        g.addEventListener('click', () => showDetails(rebalance, 'rebalance'));

        svg.appendChild(g);
      });
    });
  }

  wrapper.appendChild(svg);
  return wrapper;
}

function renderBalanceCurves(svg, viz, xScale, chains) {
  // Use actual on-chain balance snapshots directly.
  // The mock bridge doesn't pull tokens from origin (it just emits events),
  // so computing balances from events would be inaccurate.
  // The actual snapshots from KPICollector.takeSnapshot() are correct.

  const balanceTimeline = viz.balanceTimeline;
  if (balanceTimeline.length < 2) return;

  // Find min/max balance for scaling
  let minBalance = BigInt('999999999999999999999999999');
  let maxBalance = 0n;
  balanceTimeline.forEach(snapshot => {
    Object.values(snapshot.balances).forEach(b => {
      const bal = BigInt(b);
      if (bal > maxBalance) maxBalance = bal;
      if (bal < minBalance) minBalance = bal;
    });
  });

  if (maxBalance === 0n) return;
  const balanceRange = maxBalance - minBalance || 1n;

  chains.forEach((chain, chainIndex) => {
    const chainY = MARGIN.top + chainIndex * ROW_HEIGHT;
    const curveTop = chainY + 15;
    const curveBottom = chainY + ROW_HEIGHT - 15;
    const curveHeight = curveBottom - curveTop;
    const color = CHAIN_COLORS[chain] || TRANSFER_COLORS[chainIndex % TRANSFER_COLORS.length];

    // Build path data from actual balance timeline
    const points = balanceTimeline.map(snapshot => {
      const x = xScale(snapshot.timestamp);
      const balance = BigInt(snapshot.balances[chain] || '0');
      // Scale: high balance = top, low balance = bottom
      const normalizedY = balanceRange > 0n
        ? Number((balance - minBalance) * BigInt(Math.floor(curveHeight * 100)) / balanceRange) / 100
        : curveHeight / 2;
      const y = curveBottom - normalizedY;
      return { x, y, balance };
    });

    // Area fill
    const areaD = 'M' + points.map(p => p.x + ',' + p.y).join(' L') +
      ' L' + points[points.length-1].x + ',' + curveBottom +
      ' L' + points[0].x + ',' + curveBottom + ' Z';
    const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    area.setAttribute('class', 'balance-area');
    area.setAttribute('d', areaD);
    area.setAttribute('fill', color);
    svg.appendChild(area);

    // Line path (step function for clearer visualization)
    let pathD = 'M' + points[0].x + ',' + points[0].y;
    for (let i = 1; i < points.length; i++) {
      // Horizontal then vertical for step effect
      pathD += ' L' + points[i].x + ',' + points[i-1].y;
      pathD += ' L' + points[i].x + ',' + points[i].y;
    }
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'balance-line');
    path.setAttribute('d', pathD);
    path.setAttribute('stroke', color);
    svg.appendChild(path);

    // Balance labels (start and end values)
    const startBal = points[0].balance;
    const endBal = points[points.length - 1].balance;

    const startLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    startLabel.setAttribute('class', 'balance-label');
    startLabel.setAttribute('x', points[0].x + 3);
    startLabel.setAttribute('y', points[0].y - 3);
    startLabel.textContent = formatBalanceShort(startBal);
    startLabel.setAttribute('fill', color);
    svg.appendChild(startLabel);

    const endLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    endLabel.setAttribute('class', 'balance-label');
    endLabel.setAttribute('x', points[points.length-1].x - 3);
    endLabel.setAttribute('y', points[points.length-1].y - 3);
    endLabel.setAttribute('text-anchor', 'end');
    endLabel.textContent = formatBalanceShort(endBal);
    endLabel.setAttribute('fill', color);
    svg.appendChild(endLabel);
  });
}

function renderLegend(container, viz) {
  const transferCount = viz.transfers.length;

  let transferItems = '';
  for (let i = 0; i < transferCount; i++) {
    const t = viz.transfers[i];
    const color = TRANSFER_COLORS[i % TRANSFER_COLORS.length];
    transferItems += \`
      <div class="legend-item">
        <div class="legend-color" style="background: \${color}"></div>
        <span>T\${i + 1}: \${t.origin} → \${t.destination} (\${formatBalanceShort(BigInt(t.amount))})</span>
      </div>
    \`;
  }

  let chainItems = '';
  viz.chains.forEach(chain => {
    const color = CHAIN_COLORS[chain] || '#888';
    chainItems += \`
      <div class="legend-item">
        <div class="legend-line" style="background: \${color}"></div>
        <span>\${chain} collateral balance</span>
      </div>
    \`;
  });

  container.innerHTML = \`
    <div class="legend-section">
      <div class="legend-title">Transfers</div>
      \${transferItems}
    </div>
    <div class="legend-section">
      <div class="legend-title">Markers</div>
      <div class="legend-item">
        <div class="legend-marker" style="background: #fff"></div>
        <span>Transfer start</span>
      </div>
      <div class="legend-item">
        <div class="legend-marker" style="background: #4ecdc4; transform: rotate(45deg)"></div>
        <span>Transfer delivered</span>
      </div>
      <div class="legend-item">
        <div class="legend-marker" style="background: \${REBALANCE_COLOR}"></div>
        <span>Rebalance (R)</span>
      </div>
    </div>
    <div class="legend-section">
      <div class="legend-title">Balance Curves</div>
      \${chainItems}
    </div>
  \`;
}

let tooltipEl = null;

function showTooltip(event, data, type) {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'tooltip';
    document.body.appendChild(tooltipEl);
  }

  let content = '';
  if (type === 'transfer') {
    const status = data.status === 'completed' ? '✓ Delivered' :
                   data.status === 'failed' ? '✗ Failed' : '⏳ Pending';
    content = \`
      <strong>Transfer T\${data._index + 1}</strong><br>
      <b>Route:</b> \${data.origin} → \${data.destination}<br>
      <b>Amount:</b> \${formatAmount(data.amount)}<br>
      <b>Latency:</b> \${data.latency ? data.latency + 'ms' : 'N/A'}<br>
      <b>Status:</b> \${status}
    \`;
  } else {
    const status = data.status === 'completed' ? '✓ Delivered' :
                   data.status === 'failed' ? '✗ Failed' : '⏳ Pending';
    content = \`
      <strong>Rebalance R\${data._index + 1}</strong><br>
      <b>Route:</b> \${data.origin} → \${data.destination}<br>
      <b>Amount:</b> \${formatAmount(data.amount)}<br>
      <b>Latency:</b> \${data.latency ? data.latency + 'ms' : 'N/A'}<br>
      <b>Status:</b> \${status}
    \`;
  }

  tooltipEl.innerHTML = content;
  tooltipEl.style.left = (event.pageX + 15) + 'px';
  tooltipEl.style.top = (event.pageY + 15) + 'px';
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
      <h3>Transfer T\${data._index + 1} Details</h3>
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
      <h3>Rebalance R\${data._index + 1} Details</h3>
      <div class="detail-row"><span class="detail-label">ID:</span><span class="detail-value">\${data.id}</span></div>
      <div class="detail-row"><span class="detail-label">Route:</span><span class="detail-value">\${data.origin} → \${data.destination}</span></div>
      <div class="detail-row"><span class="detail-label">Amount:</span><span class="detail-value">\${formatAmount(data.amount)}</span></div>
      <div class="detail-row"><span class="detail-label">Start:</span><span class="detail-value">\${new Date(data.startTime).toISOString()}</span></div>
      <div class="detail-row"><span class="detail-label">End:</span><span class="detail-value">\${data.endTime ? new Date(data.endTime).toISOString() : 'N/A'}</span></div>
      <div class="detail-row"><span class="detail-label">Latency:</span><span class="detail-value">\${data.latency ? data.latency + 'ms' : 'N/A'}</span></div>
      <div class="detail-row"><span class="detail-label">Gas Cost:</span><span class="detail-value">\${formatAmount(data.gasCost)}</span></div>
      <div class="detail-row"><span class="detail-label">Status:</span><span class="detail-value">\${data.status}</span></div>
    \`;
  }

  panel.innerHTML = html;
}

function formatAmount(amount) {
  const val = BigInt(amount);
  const eth = Number(val) / 1e18;
  if (eth >= 1) return eth.toFixed(2) + ' tokens';
  if (eth >= 0.001) return (eth * 1000).toFixed(2) + ' mTokens';
  return val.toString() + ' wei';
}

function formatBalanceShort(balance) {
  const eth = Number(balance) / 1e18;
  if (eth >= 1000) return (eth / 1000).toFixed(1) + 'k';
  if (eth >= 1) return eth.toFixed(0);
  return eth.toFixed(2);
}
  `;
}
