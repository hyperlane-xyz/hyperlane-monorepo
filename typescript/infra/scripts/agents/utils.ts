import {
  AgentHelmManager,
  RelayerHelmManager,
  ScraperHelmManager,
  ValidatorHelmManager,
} from '../../src/agents';
import { EnvironmentConfig, RootAgentConfig } from '../../src/config';
import { Role } from '../../src/roles';
import { HelmCommand } from '../../src/utils/helm';
import {
  assertCorrectKubeContext,
  getArgs,
  getConfigsBasedOnArgs,
  withAgentRole,
  withContext,
} from '../utils';

type GetConfigsArgv = NonNullable<Parameters<typeof getConfigsBasedOnArgs>[0]>;

export class AgentCli {
  roles!: Role[];
  envConfig!: EnvironmentConfig;
  agentConfig!: RootAgentConfig;
  initialized = false;
  dryRun = false;

  public async runHelmCommand(command: HelmCommand) {
    await this.init();
    // use keys to ensure uniqueness
    const managers: Record<string, AgentHelmManager> = {};
    // make all the managers first to ensure config validity
    for (const role of this.roles) {
      switch (role) {
        case Role.Validator:
          for (const chain of this.agentConfig.contextChainNames) {
            const key = `${role}-${chain}`;
            managers[key] = new ValidatorHelmManager(this.agentConfig, chain);
          }
          break;
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

    await Promise.all(
      Object.values(managers).map((m) =>
        m.runHelmCommand(command, this.dryRun),
      ),
    );
  }

  protected async init(
    argv?: GetConfigsArgv & { role: Role[]; 'dry-run'?: boolean },
  ) {
    if (this.initialized) return;
    if (!argv)
      argv = await withAgentRole(withContext(getArgs()))
        .describe('dry-run', 'Run through the steps without making any changes')
        .boolean('dry-run').argv;

    const { envConfig, agentConfig } = await getConfigsBasedOnArgs(argv);
    await assertCorrectKubeContext(envConfig);
    this.roles = argv.role;
    this.envConfig = envConfig;
    this.agentConfig = agentConfig;
    this.dryRun = argv['dry-run'] || false;
    this.initialized = true;
  }
}
