import { concurrentMap } from '@hyperlane-xyz/utils';

import {
  AgentHelmManager,
  RelayerHelmManager,
  ScraperHelmManager,
  ValidatorHelmManager,
} from '../../src/agents/index.js';
import { RootAgentConfig } from '../../src/config/agent/agent.js';
import { EnvironmentConfig } from '../../src/config/environment.js';
import { Role } from '../../src/roles.js';
import { HelmCommand } from '../../src/utils/helm.js';
import { K8sResourceType, refreshK8sResources } from '../../src/utils/k8s.js';
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

    await concurrentMap(
      this.concurrency,
      Object.entries(managers),
      async ([key, manager]) => {
        console.log(`Running helm command for ${key}`);
        await manager.runHelmCommand(command, { dryRun: this.dryRun });
      },
    );
  }

  protected async init() {
    if (this.initialized) return;
    const argv = await withConcurrency(
      withChains(withAgentRolesRequired(withContext(getArgs()))),
    )
      .describe('dry-run', 'Run through the steps without making any changes')
      .boolean('dry-run').argv;

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
    this.initialized = true;
    this.chains = argv.chains;
    this.concurrency = argv.concurrency;
  }

  private managers(): Record<string, AgentHelmManager> {
    // use keys to ensure uniqueness
    const managers: Record<string, AgentHelmManager> = {};
    // make all the managers first to ensure config validity
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
