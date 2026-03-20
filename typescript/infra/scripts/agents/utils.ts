import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';

import { concurrentMap, mapAllSettled, rootLogger } from '@hyperlane-xyz/utils';

import {
  AgentHelmManager,
  RelayerHelmManager,
  ScraperHelmManager,
  ValidatorHelmManager,
} from '../../src/agents/index.js';
import { RootAgentConfig } from '../../src/config/agent/agent.js';
import { EnvironmentConfig } from '../../src/config/environment.js';
import { Role } from '../../src/roles.js';
import {
  HelmCommand,
  PreflightDiff,
  buildHelmChartDependencies,
} from '../../src/utils/helm.js';
import { K8sResourceType, refreshK8sResources } from '../../src/utils/k8s.js';
import { printPreflightSummaryTable } from '../../src/utils/log.js';
import {
  assertCorrectKubeContext,
  getArgs,
  withAgentRolesRequired,
  withChains,
  withConcurrency,
  withContext,
} from '../agent-utils.js';
import { getConfigsBasedOnArgs } from '../core-utils.js';

export class AgentCli {
  roles!: Role[];
  envConfig!: EnvironmentConfig;
  agentConfig!: RootAgentConfig;
  initialized = false;
  dryRun = false;
  chains?: string[];
  concurrency = 1;
  skipPreflightCheck = false;

  public async restartAgents() {
    await this.init();
    const managers = this.managers();
    await refreshK8sResources(
      Object.values(managers),
      K8sResourceType.POD,
      this.envConfig.environment,
    );
  }

  public async runHelmCommand(command: HelmCommand) {
    await this.init();
    const managers = this.managers();

    if (this.dryRun) {
      const values = await Promise.all(
        Object.values(managers).map(async (m) => m.helmValues()),
      );
      console.log('Dry run values:\n', JSON.stringify(values, null, 2));
    }

    const managerList = Object.values(managers);

    if (
      command === HelmCommand.InstallOrUpgrade &&
      !this.dryRun &&
      !this.skipPreflightCheck
    ) {
      const shouldProceed = await this.runPreflightChecks(managers);
      if (!shouldProceed) {
        console.log(
          chalk.yellow(
            'Deployment aborted. To skip pre-flight checks, use --skip-preflight-check flag.',
          ),
        );
        process.exit(1);
      }
    }

    if (managerList.length > 0 && command !== HelmCommand.Remove) {
      rootLogger.info('Building helm chart dependencies...');
      await buildHelmChartDependencies(managerList[0].helmChartPath, false);
    }

    const originalProcessMax = process.getMaxListeners();
    const originalStdoutMax = process.stdout.getMaxListeners();
    const originalStderrMax = process.stderr.getMaxListeners();
    const requiredListeners = this.concurrency + 10;
    process.setMaxListeners(requiredListeners);
    process.stdout.setMaxListeners(requiredListeners);
    process.stderr.setMaxListeners(requiredListeners);

    try {
      await concurrentMap(
        this.concurrency,
        Object.entries(managers),
        async ([key, manager]) => {
          console.log(`Running helm command for ${key}`);
          await manager.runHelmCommand(command, {
            dryRun: this.dryRun,
            skipDependencyBuild: true,
          });
        },
      );
    } finally {
      process.setMaxListeners(originalProcessMax);
      process.stdout.setMaxListeners(originalStdoutMax);
      process.stderr.setMaxListeners(originalStderrMax);
    }
  }

  protected async init() {
    if (this.initialized) return;
    const argv = await withConcurrency(
      withChains(withAgentRolesRequired(withContext(getArgs()))),
    )
      .describe('dry-run', 'Run through the steps without making any changes')
      .boolean('dry-run')
      .describe(
        'skip-preflight-check',
        'Skip the pre-flight check that compares against currently deployed configuration',
      )
      .boolean('skip-preflight-check').argv;

    if (
      argv.chains &&
      argv.chains.length > 0 &&
      !argv.roles.includes(Role.Validator)
    ) {
      console.warn('Chain argument applies to validator role only. Ignoring.');
    }

    const { envConfig, agentConfig } = await getConfigsBasedOnArgs(argv);
    await assertCorrectKubeContext(envConfig);
    this.roles = argv.roles;
    this.envConfig = envConfig;
    this.agentConfig = agentConfig;
    this.dryRun = argv.dryRun || false;
    this.skipPreflightCheck = argv.skipPreflightCheck || false;
    this.initialized = true;
    this.chains = argv.chains;
    this.concurrency = argv.concurrency;
  }

  private async runPreflightChecks(
    managers: Record<string, AgentHelmManager>,
  ): Promise<boolean> {
    console.log(chalk.cyan.bold('🔍 Running pre-flight checks...\n'));

    const managerEntries = Object.entries(managers);
    const { fulfilled, rejected } = await mapAllSettled(
      managerEntries,
      async ([key, manager]) => ({
        key,
        diff: await manager.getPreflightDiff(),
      }),
      ([key]) => key,
    );

    const diffs: Array<{ key: string; diff: PreflightDiff }> = [
      ...fulfilled.values(),
    ];
    const failures: string[] = [...rejected.entries()].map(
      ([key, error]) => `${key}: ${error.message || 'Unknown error'}`,
    );

    if (failures.length > 0) {
      console.log(chalk.red.bold('\n❌ Failed to gather pre-flight diffs:'));
      for (const failure of failures) {
        console.log(chalk.red(`  - ${failure}`));
      }
      return false;
    }

    const hasAnyChanges = diffs.some(
      ({ diff }) =>
        diff.isNewDeployment ||
        diff.chainDiff.hasChanges ||
        diff.imageDiff.hasChanges,
    );

    if (!hasAnyChanges) {
      console.log(
        chalk.green('No changes detected. Proceeding with deployment.\n'),
      );
      return true;
    }

    printPreflightSummaryTable(diffs);

    return confirm({
      message: chalk.yellow(
        `Proceed with deployment of ${diffs.length} agent(s)?`,
      ),
      default: false,
    });
  }

  private managers(): Record<string, AgentHelmManager> {
    const managers: Record<string, AgentHelmManager> = {};
    for (const role of this.roles) {
      switch (role) {
        case Role.Validator: {
          const contextChainNames = this.agentConfig.contextChainNames[role];
          const validatorChains = !this.chains
            ? contextChainNames
            : contextChainNames.filter((chain: string) =>
                this.chains!.includes(chain),
              );
          for (const chain of validatorChains) {
            const key = `${role}-${chain}`;
            managers[key] = new ValidatorHelmManager(this.agentConfig, chain);
          }
          break;
        }
        case Role.Relayer:
          managers[role] = new RelayerHelmManager(this.agentConfig);
          break;
        case Role.Scraper:
          managers[role] = new ScraperHelmManager(this.agentConfig);
          break;
        default:
          throw new Error(`Invalid role ${role}`);
      }
    }
    return managers;
  }
}
