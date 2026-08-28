#!/usr/bin/env node
import { Command } from 'commander';
import Table from 'cli-table3';
import { loadConfigFromFile } from '../config/schema';
import { KeyFunder } from '../core/KeyFunder';
import { ChainBalanceReport, FundingAction, KeyfunderConfig } from '../types';

export function formatActionsTable(actions: FundingAction[]): string {
  const table = new Table({
    head: [
      'Chain',
      'Protocol',
      'Recipient',
      'Current Bal',
      'Min Thresh',
      'Desired Bal',
      'Required',
      'Strategy',
      'Status',
      'Info / TxHash',
    ],
    style: { head: ['cyan'] },
  });

  for (const a of actions) {
    const symbol = a.symbol || '';
    const recipientDisplay = a.recipientName ? `${a.recipientName}\n(${a.recipient.slice(0, 10)}...)` : `${a.recipient.slice(0, 14)}...`;
    const statusDisplay =
      a.status === 'EXECUTED'
        ? `\x1b[32m${a.status}\x1b[0m`
        : a.status === 'FAILED'
        ? `\x1b[31m${a.status}\x1b[0m`
        : a.status === 'SKIPPED'
        ? `\x1b[33m${a.status}\x1b[0m`
        : a.status;

    const infoDisplay =
      a.txHash || a.error || a.skipReason || '-';

    table.push([
      a.chain,
      a.protocol,
      recipientDisplay,
      `${a.formattedCurrentBalance} ${symbol}`,
      `${a.formattedMinThreshold} ${symbol}`,
      `${a.formattedDesiredBalance} ${symbol}`,
      `${a.formattedRequiredFunding} ${symbol}`,
      a.strategy,
      statusDisplay,
      infoDisplay,
    ]);
  }

  return table.toString();
}

export function formatBalancesTable(reports: Record<string, ChainBalanceReport>): string {
  const table = new Table({
    head: ['Chain', 'Protocol', 'Role', 'Address / Name', 'Balance', 'Needs Funding', 'Deficit'],
    style: { head: ['green'] },
  });

  for (const [chain, report] of Object.entries(reports)) {
    table.push([
      chain,
      report.protocol,
      'Funder',
      report.funderAddress,
      report.formattedFunderBalance,
      '-',
      '-',
    ]);

    for (const rec of report.recipientBalances) {
      table.push([
        chain,
        report.protocol,
        'Recipient',
        rec.name ? `${rec.name} (${rec.recipient})` : rec.recipient,
        rec.formattedBalance,
        rec.needsFunding ? '\x1b[31mYES\x1b[0m' : '\x1b[32mNO\x1b[0m',
        rec.formattedDeficit,
      ]);
    }
  }

  return table.toString();
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name('keyfunder')
    .description('Autonomous multi-protocol funding engine for Hyperlane infrastructure')
    .version('1.0.0');

  program
    .command('check')
    .description('Evaluate balances and funding policies without executing transactions')
    .option('-c, --config <path>', 'Path to configuration JSON/YAML file', './config.json')
    .option('--dry-run', 'Simulate evaluation in dry-run mode', false)
    .action(async (options) => {
      try {
        const config = loadConfigFromFile(options.config);
        if (options.dryRun) config.dryRun = true;

        const funder = new KeyFunder(config);
        console.log('\n--- Evaluating Keyfunder Balances & Policies ---');
        const { reports, actions } = await funder.check();

        console.log('\n[Balance Report]');
        console.log(formatBalancesTable(reports));

        console.log('\n[Evaluated Funding Actions]');
        console.log(formatActionsTable(actions));
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  program
    .command('run')
    .description('Run a single complete funding cycle')
    .option('-c, --config <path>', 'Path to configuration JSON/YAML file', './config.json')
    .option('--dry-run', 'Simulate execution in dry-run mode', false)
    .action(async (options) => {
      try {
        const config = loadConfigFromFile(options.config);
        if (options.dryRun) config.dryRun = true;

        const funder = new KeyFunder(config);
        console.log('\n--- Executing Keyfunder Cycle ---');
        const { actions } = await funder.runOnce();

        console.log('\n[Funding Cycle Execution Results]');
        console.log(formatActionsTable(actions));
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  program
    .command('start')
    .description('Start Keyfunder daemon in continuous loop mode')
    .option('-c, --config <path>', 'Path to configuration JSON/YAML file', './config.json')
    .option('-i, --interval <seconds>', 'Funding loop interval in seconds')
    .option('-p, --port <port>', 'Prometheus metrics server port')
    .option('--dry-run', 'Run daemon in dry-run simulation mode', false)
    .action(async (options) => {
      try {
        const config = loadConfigFromFile(options.config);
        if (options.dryRun) config.dryRun = true;
        if (options.port) config.metricsPort = parseInt(options.port, 10);
        const interval = options.interval ? parseInt(options.interval, 10) : undefined;

        const funder = new KeyFunder(config);
        console.log(`Starting Keyfunder daemon (Interval: ${interval || config.intervalSec || 60}s)...`);

        const shutdown = async () => {
          console.log('\nStopping Keyfunder daemon gracefully...');
          await funder.stopDaemon();
          process.exit(0);
        };

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        await funder.startDaemon(interval);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  program
    .command('topup')
    .description('Manually trigger an immediate top-up for a recipient')
    .requiredOption('-c, --config <path>', 'Path to configuration file')
    .requiredOption('--chain <name>', 'Chain name')
    .requiredOption('--recipient <address>', 'Recipient address')
    .requiredOption('--amount <amount>', 'Amount in native units (e.g. 0.5)')
    .option('-s, --strategy <strategy>', 'Override strategy')
    .option('--dry-run', 'Dry-run mode', false)
    .action(async (options) => {
      try {
        const config = loadConfigFromFile(options.config);
        const funder = new KeyFunder(config);

        console.log(`Executing manual topup of ${options.amount} on ${options.chain} to ${options.recipient}...`);
        const action = await funder.topUpRecipient(
          options.chain,
          options.recipient,
          options.amount,
          options.strategy,
          options.dryRun
        );

        console.log('\n[Top-up Result]');
        console.log(formatActionsTable([action]));
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  return program;
}

if (require.main === module) {
  const program = createProgram();
  program.parse(process.argv);
}
