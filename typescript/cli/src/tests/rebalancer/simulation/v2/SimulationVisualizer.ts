/**
 * SimulationVisualizer
 *
 * Creates visual ASCII timeline output showing:
 * - Collateral balances over time
 * - Traffic direction and volume
 * - Rebalancing events
 * - Key metrics
 */
import type { SimulationResults, EnhancedTimeSeriesPoint, TransferEvent } from './types.js';

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
};

/**
 * Format a number with thousands separators.
 */
function formatNumber(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

/**
 * Format time in minutes.
 */
function formatTime(ms: number): string {
  const minutes = ms / (60 * 1000);
  if (minutes < 60) {
    return `${minutes.toFixed(0)}m`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = Math.floor(minutes % 60);
  return `${hours}h${mins}m`;
}

/**
 * Format bigint as token amount.
 */
function formatTokens(amount: bigint): string {
  const tokens = Number(amount) / 1e18;
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return tokens.toFixed(1);
}

/**
 * Create a simple bar chart character representation.
 */
function createBar(value: number, maxValue: number, width: number): string {
  const filled = Math.round((value / maxValue) * width);
  const empty = width - filled;
  return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, empty));
}

/**
 * Visualize simulation results.
 */
export function visualizeSimulation(results: SimulationResults, useColors: boolean = true): string {
  const c = useColors ? colors : {
    reset: '', bright: '', dim: '', red: '', green: '', yellow: '',
    blue: '', magenta: '', cyan: '', white: '', bgRed: '', bgGreen: '',
    bgYellow: '', bgBlue: '',
  };

  const lines: string[] = [];
  const width = 80;

  // Header
  lines.push('');
  lines.push(c.bright + '═'.repeat(width) + c.reset);
  lines.push(c.bright + centerText(`SIMULATION: ${results.name}`, width) + c.reset);
  lines.push(c.bright + '═'.repeat(width) + c.reset);

  // Summary stats
  lines.push('');
  lines.push(c.cyan + '📊 SUMMARY' + c.reset);
  lines.push(`   Duration: ${formatTime(results.duration.simulatedMs)} simulated in ${results.duration.wallClockMs}ms wall clock (${(results.duration.simulatedMs / results.duration.wallClockMs).toFixed(0)}x speedup)`);
  lines.push(`   Transfers: ${results.transfers.completed}/${results.transfers.total} completed (${results.transfers.stuck} stuck)`);
  lines.push(`   Rebalances: ${results.rebalancing.count} totaling ${formatTokens(results.rebalancing.totalVolume)} tokens`);
  lines.push(`   Fees paid: ${formatTokens(results.rebalancing.totalFees)} tokens`);

  // Timeline visualization
  const timeSeries = results.enhancedTimeSeries || results.timeSeries;
  if (timeSeries.length > 0) {
    lines.push('');
    lines.push(c.cyan + '📈 BALANCE TIMELINE' + c.reset);
    lines.push('');

    // Get all chain names and find max balance for scaling
    const chainNames = Object.keys(timeSeries[0].balances);
    let maxBalance = 0n;
    for (const point of timeSeries) {
      for (const balance of Object.values(point.balances)) {
        if (balance > maxBalance) maxBalance = balance;
      }
    }

    // Sample time series for display (max ~20 points)
    const sampleRate = Math.max(1, Math.floor(timeSeries.length / 20));
    const sampledPoints = timeSeries.filter((_, i) => i % sampleRate === 0 || i === timeSeries.length - 1);

    // Header row
    const timeColWidth = 8;
    const barWidth = 20;
    let header = '   ' + 'Time'.padEnd(timeColWidth);
    for (const chain of chainNames) {
      header += ' │ ' + chain.padEnd(barWidth + 8);
    }
    header += ' │ Events';
    lines.push(c.dim + header + c.reset);
    lines.push(c.dim + '   ' + '─'.repeat(timeColWidth) + ('─┼─' + '─'.repeat(barWidth + 8)).repeat(chainNames.length) + '─┼─' + '─'.repeat(20) + c.reset);

    // Data rows
    for (const point of sampledPoints) {
      let row = '   ' + formatTime(point.time).padEnd(timeColWidth);

      for (const chain of chainNames) {
        const balance = point.balances[chain];
        const tokens = Number(balance) / 1e18;
        const bar = createBar(Number(balance), Number(maxBalance), barWidth);
        
        // Color the bar based on balance level (relative to total/chains)
        const totalBalance = chainNames.reduce((sum, c) => sum + Number(point.balances[c]), 0);
        const targetBalance = totalBalance / chainNames.length;
        const deviation = (tokens - targetBalance) / targetBalance;
        
        let barColor = c.green;
        if (Math.abs(deviation) > 0.2) barColor = c.yellow;
        if (Math.abs(deviation) > 0.4) barColor = c.red;
        
        row += ' │ ' + barColor + bar + c.reset + ` ${formatTokens(balance).padStart(6)}`;
      }

      // Events column
      const enhancedPoint = point as EnhancedTimeSeriesPoint;
      let eventStr = '';
      if (enhancedPoint.events) {
        const transfers = enhancedPoint.events.filter(e => e.type === 'transfer_initiated').length;
        const rebalances = enhancedPoint.events.filter(e => e.type === 'rebalance_initiated').length;
        if (transfers > 0) eventStr += c.blue + `↔${transfers}` + c.reset + ' ';
        if (rebalances > 0) eventStr += c.magenta + `⚡${rebalances}` + c.reset + ' ';
      }
      if (point.pendingTransfers > 0) {
        eventStr += c.yellow + `⏳${point.pendingTransfers}` + c.reset;
      }
      row += ' │ ' + eventStr;

      lines.push(row);
    }

    // Legend
    lines.push('');
    lines.push(c.dim + '   Legend: ' + c.blue + '↔' + c.reset + c.dim + '=transfers ' + c.magenta + '⚡' + c.reset + c.dim + '=rebalances ' + c.yellow + '⏳' + c.reset + c.dim + '=pending' + c.reset);
    lines.push(c.dim + '   Bar colors: ' + c.green + '██' + c.reset + c.dim + '=balanced ' + c.yellow + '██' + c.reset + c.dim + '=20%+ deviation ' + c.red + '██' + c.reset + c.dim + '=40%+ deviation' + c.reset);
  }

  // Traffic analysis
  lines.push('');
  lines.push(c.cyan + '🚦 TRAFFIC ANALYSIS' + c.reset);
  
  // Aggregate traffic by direction
  const trafficByDirection: Record<string, { count: number; volume: bigint }> = {};
  for (const metric of (results as any).transferMetrics || []) {
    const key = `${metric.origin} → ${metric.destination}`;
    if (!trafficByDirection[key]) {
      trafficByDirection[key] = { count: 0, volume: 0n };
    }
    trafficByDirection[key].count++;
    trafficByDirection[key].volume += metric.amount;
  }

  // If no transferMetrics, try to reconstruct from enhanced time series
  if (Object.keys(trafficByDirection).length === 0 && results.enhancedTimeSeries) {
    for (const point of results.enhancedTimeSeries) {
      for (const event of point.events || []) {
        if (event.type === 'transfer_initiated') {
          const key = `${event.origin} → ${event.destination}`;
          if (!trafficByDirection[key]) {
            trafficByDirection[key] = { count: 0, volume: 0n };
          }
          trafficByDirection[key].count++;
          trafficByDirection[key].volume += event.amount;
        }
      }
    }
  }

  if (Object.keys(trafficByDirection).length > 0) {
    for (const [direction, stats] of Object.entries(trafficByDirection)) {
      lines.push(`   ${direction}: ${stats.count} transfers, ${formatTokens(stats.volume)} tokens`);
    }
  } else {
    lines.push(`   ${results.transfers.total} total transfers`);
  }

  // Rebalancing breakdown
  if (results.rebalancing.count > 0) {
    lines.push('');
    lines.push(c.cyan + '⚖️  REBALANCING BREAKDOWN' + c.reset);
    
    for (const [route, stats] of Object.entries(results.rebalancing.byBridge)) {
      lines.push(`   ${route}: ${stats.count}x, ${formatTokens(stats.volume)} tokens, ${formatTokens(stats.fees)} fees`);
    }
  }

  // Latency stats
  if (results.transfers.completed > 0) {
    lines.push('');
    lines.push(c.cyan + '⏱️  LATENCY' + c.reset);
    lines.push(`   Min: ${(results.transfers.latency.min / 1000).toFixed(1)}s`);
    lines.push(`   Mean: ${(results.transfers.latency.mean / 1000).toFixed(1)}s`);
    lines.push(`   P95: ${(results.transfers.latency.p95 / 1000).toFixed(1)}s`);
    lines.push(`   Max: ${(results.transfers.latency.max / 1000).toFixed(1)}s`);
  }

  // Final balances
  if (timeSeries.length > 0) {
    const finalPoint = timeSeries[timeSeries.length - 1];
    const initialPoint = timeSeries[0];
    
    lines.push('');
    lines.push(c.cyan + '💰 FINAL BALANCES' + c.reset);
    
    const chainNames = Object.keys(finalPoint.balances);
    const totalFinal = chainNames.reduce((sum, c) => sum + Number(finalPoint.balances[c]), 0);
    const targetBalance = totalFinal / chainNames.length;
    
    for (const chain of chainNames) {
      const initial = Number(initialPoint.balances[chain]) / 1e18;
      const final = Number(finalPoint.balances[chain]) / 1e18;
      const change = final - initial;
      const changeStr = change >= 0 ? c.green + `+${change.toFixed(1)}` : c.red + change.toFixed(1);
      const deviation = ((final - targetBalance / 1e18) / (targetBalance / 1e18) * 100).toFixed(1);
      const deviationColor = Math.abs(parseFloat(deviation)) > 20 ? c.yellow : c.green;
      
      lines.push(`   ${chain}: ${final.toFixed(1)} tokens (${changeStr}${c.reset}) [${deviationColor}${deviation}% from target${c.reset}]`);
    }
  }

  // Footer
  lines.push('');
  lines.push(c.bright + '═'.repeat(width) + c.reset);
  lines.push('');

  return lines.join('\n');
}

/**
 * Center text within a given width.
 */
function centerText(text: string, width: number): string {
  const padding = Math.max(0, Math.floor((width - text.length) / 2));
  return ' '.repeat(padding) + text;
}

/**
 * Create a comparison visualization between two simulation runs.
 */
export function compareSimulations(
  baseline: SimulationResults,
  withRebalancer: SimulationResults,
  useColors: boolean = true,
): string {
  const c = useColors ? colors : {
    reset: '', bright: '', dim: '', red: '', green: '', yellow: '',
    blue: '', magenta: '', cyan: '', white: '', bgRed: '', bgGreen: '',
    bgYellow: '', bgBlue: '',
  };

  const lines: string[] = [];
  const width = 80;

  lines.push('');
  lines.push(c.bright + '═'.repeat(width) + c.reset);
  lines.push(c.bright + centerText('COMPARISON: WITH vs WITHOUT REBALANCER', width) + c.reset);
  lines.push(c.bright + '═'.repeat(width) + c.reset);

  lines.push('');
  lines.push(c.cyan + '📊 METRICS COMPARISON' + c.reset);
  lines.push('');
  
  const metrics = [
    ['Transfers completed', baseline.transfers.completed, withRebalancer.transfers.completed],
    ['Transfers stuck', baseline.transfers.stuck, withRebalancer.transfers.stuck],
    ['Rebalances executed', baseline.rebalancing.count, withRebalancer.rebalancing.count],
    ['Rebalance volume', formatTokens(baseline.rebalancing.totalVolume), formatTokens(withRebalancer.rebalancing.totalVolume)],
    ['Fees paid', formatTokens(baseline.rebalancing.totalFees), formatTokens(withRebalancer.rebalancing.totalFees)],
  ];

  lines.push('   ' + 'Metric'.padEnd(25) + 'Without'.padStart(15) + 'With'.padStart(15) + 'Diff'.padStart(15));
  lines.push(c.dim + '   ' + '─'.repeat(70) + c.reset);

  for (const [name, without, withVal] of metrics) {
    let diff = '';
    if (typeof without === 'number' && typeof withVal === 'number') {
      const d = withVal - without;
      diff = d > 0 ? c.green + `+${d}` + c.reset : d < 0 ? c.red + `${d}` + c.reset : '0';
    }
    lines.push(`   ${String(name).padEnd(25)}${String(without).padStart(15)}${String(withVal).padStart(15)}${diff.padStart(15)}`);
  }

  // Balance comparison at end
  const baselineTimeSeries = baseline.enhancedTimeSeries || baseline.timeSeries;
  const withTimeSeries = withRebalancer.enhancedTimeSeries || withRebalancer.timeSeries;
  
  if (baselineTimeSeries.length > 0 && withTimeSeries.length > 0) {
    lines.push('');
    lines.push(c.cyan + '💰 FINAL BALANCE DEVIATION FROM TARGET' + c.reset);
    
    const baselineFinal = baselineTimeSeries[baselineTimeSeries.length - 1];
    const withFinal = withTimeSeries[withTimeSeries.length - 1];
    
    const chainNames = Object.keys(baselineFinal.balances);
    
    for (const chain of chainNames) {
      const baselineTotal = chainNames.reduce((sum, c) => sum + Number(baselineFinal.balances[c]), 0);
      const withTotal = chainNames.reduce((sum, c) => sum + Number(withFinal.balances[c]), 0);
      
      const baselineTarget = baselineTotal / chainNames.length;
      const withTarget = withTotal / chainNames.length;
      
      const baselineDev = Math.abs((Number(baselineFinal.balances[chain]) - baselineTarget) / baselineTarget * 100);
      const withDev = Math.abs((Number(withFinal.balances[chain]) - withTarget) / withTarget * 100);
      
      const improvement = baselineDev - withDev;
      const improvementStr = improvement > 0 
        ? c.green + `${improvement.toFixed(1)}% better` + c.reset
        : improvement < 0 
          ? c.red + `${Math.abs(improvement).toFixed(1)}% worse` + c.reset
          : 'same';
      
      lines.push(`   ${chain}: ${baselineDev.toFixed(1)}% → ${withDev.toFixed(1)}% (${improvementStr})`);
    }
  }

  lines.push('');
  lines.push(c.bright + '═'.repeat(width) + c.reset);
  lines.push('');

  return lines.join('\n');
}
