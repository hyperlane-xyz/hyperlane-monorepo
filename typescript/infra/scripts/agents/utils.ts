import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';

import { concurrentMap, rootLogger } from '@hyperlane-xyz/utils';

import {
  RelayerHelmManager,
  ScraperHelmManager,
  ScraperProxyHelmManager,
  ValidatorHelmManager,
} from '../../src/agents/index.js';
import {
  HelmRootAgentValues,
  RootAgentConfig,
} from '../../src/config/agent/agent.js';
import { EnvironmentConfig } from '../../src/config/environment.js';
import { Role } from '../../src/roles.js';
import {
  HelmCommand,
  HelmManager,
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
  withYes,
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
  skipConfirmation = false;

  public async restartAgents() {
    await this.init();
    const managers = this.managers();
    const statefulSetManagers = Object.values(managers).filter(
      (manager) => !(manager instanceof ScraperProxyHelmManager),
    );
    if (statefulSetManagers.length > 0) {
      await refreshK8sResources(
        statefulSetManagers,
        K8sResourceType.POD,
        this.envConfig.environment,
      );
    }

    const scraperProxyManager = managers[Role.ScraperProxy];
    if (scraperProxyManager instanceof ScraperProxyHelmManager) {
      await scraperProxyManager.restartDeployment();
    }
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
        console.log(chalk.yellow('Deployment aborted.'));
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

    const failures: unknown[] = [];
    try {
      await concurrentMap(
        this.concurrency,
        Object.entries(managers),
        async ([key, manager]) => {
          if (failures.length > 0) return;
          console.log(`Running helm command for ${key}`);
          try {
            await manager.runHelmCommand(command, {
              dryRun: this.dryRun,
              skipDependencyBuild: true,
              allowResourceProvisioning: !this.skipPreflightCheck,
            });
          } catch (error) {
            failures.push(error);
          }
        },
      );
    } finally {
      process.setMaxListeners(originalProcessMax);
      process.stdout.setMaxListeners(originalStdoutMax);
      process.stderr.setMaxListeners(originalStderrMax);
    }
    if (failures.length > 0) throw failures[0];
  }

  protected async init() {
    if (this.initialized) return;
    const argv = await withYes(
      withConcurrency(
        withChains(withAgentRolesRequired(withContext(getArgs()))),
      ),
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
    this.skipConfirmation = argv.yes || false;
    this.initialized = true;
    this.chains = argv.chains;
    this.concurrency = argv.concurrency;
  }

  protected async runPreflightChecks(
    managers: Record<string, HelmManager<HelmRootAgentValues>>,
  ): Promise<boolean> {
    console.log(chalk.cyan.bold('🔍 Running pre-flight checks...\n'));

    const managerEntries = Object.entries(managers);
    const results = await concurrentMap(
      this.concurrency,
      managerEntries,
      async ([key, manager]) => {
        try {
          return { key, diff: await manager.getPreflightDiff(), error: null };
        } catch (error) {
          return {
            key,
            diff: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    );

    const diffs: Array<{ key: string; diff: PreflightDiff }> = [];
    const failures: string[] = [];
    for (const { key, diff, error } of results) {
      if (diff) diffs.push({ key, diff });
      else failures.push(`${key}: ${error}`);
    }

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
        diff.imageDiff.hasChanges ||
        (diff.resourceChanges?.length ?? 0) > 0,
    );

    if (!hasAnyChanges) {
      console.log(
        chalk.green('No changes detected. Proceeding with deployment.\n'),
      );
      return true;
    }

    printPreflightSummaryTable(diffs);

    const provisioningManagers = diffs
      .filter(({ diff }) => (diff.resourceChanges?.length ?? 0) > 0)
      .map(({ key }) => managers[key])
      .filter(
        (manager): manager is ValidatorHelmManager =>
          manager instanceof ValidatorHelmManager,
      );
    const keysToCreate = [
      ...new Set(
        (
          await concurrentMap(
            this.concurrency,
            provisioningManagers,
            (manager) => manager.getKeysToCreate(),
          )
        ).flat(),
      ),
    ];
    if (
      provisioningManagers.length > 0 &&
      !(await this.confirmResourceProvisioning(
        provisioningManagers.map((manager) => manager.helmReleaseName),
        keysToCreate,
      ))
    ) {
      return false;
    }

    if (this.skipConfirmation) {
      console.log(
        chalk.yellow('--yes set; proceeding with deployment without prompt.'),
      );
      return true;
    }

    return confirm({
      message: chalk.yellow(
        `Proceed with deployment of ${diffs.length} agent(s)?`,
      ),
      default: false,
    });
  }

  protected async confirmResourceProvisioning(
    releases: string[],
    keysToCreate: string[],
  ): Promise<boolean> {
    const keyMessage =
      keysToCreate.length > 0
        ? `New keys will be created: ${keysToCreate.join(', ')}.`
        : 'Existing keys will be reused.';
    return confirm({
      message: chalk.yellow.bold(
        `GCP validator checkpoint storage or IAM will be provisioned for ${releases.join(', ')}. ${keyMessage} Are you sure you want to continue?`,
      ),
      default: false,
    });
  }

  private managers(): Record<string, HelmManager<HelmRootAgentValues>> {
    const managers: Record<string, HelmManager<HelmRootAgentValues>> = {};
    for (const role of this.roles) {
      switch (role) {
        case Role.Validator: {
          const contextChainNames = this.agentConfig.contextChainNames[role];
          const validatorChains = !this.chains
            ? contextChainNames
            : contextChainNames.filter((chain: string) =>
                this.chains!.includes(chain),
              );
          const configuredValidatorChains = validatorChains.filter(
            (chain) =>
              (this.agentConfig.validators?.chains[chain]?.validators.length ??
                0) > 0,
          );
          for (const chain of configuredValidatorChains) {
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
        case Role.ScraperProxy:
          managers[role] = new ScraperProxyHelmManager(this.agentConfig);
          break;
        default:
          throw new Error(`Invalid role ${role}`);
      }
    }
    return managers;
  }
}
