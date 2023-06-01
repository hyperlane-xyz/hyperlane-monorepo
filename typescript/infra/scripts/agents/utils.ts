import {
  RelayerHelmManager,
  ScraperHelmManager,
  ValidatorHelmManager,
} from '../../src/agents';
import { KeyRole } from '../../src/agents/roles';
import { AgentConfig, EnvironmentConfig } from '../../src/config';
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
  roles!: KeyRole[];
  envConfig!: EnvironmentConfig;
  agentConfig!: AgentConfig;
  initialized = false;

  public async runHelmCommand(command: HelmCommand) {
    await this.init();
    for (const role of this.roles) {
      switch (role) {
        case KeyRole.Validator:
          await this.runHelmCommandForValidators(command);
          break;
        case KeyRole.Relayer:
          await new RelayerHelmManager(this.agentConfig).runHelmCommand(
            command,
          );
          break;
        case KeyRole.Scraper:
          await new ScraperHelmManager(this.agentConfig).runHelmCommand(
            command,
          );
          break;
        default:
          throw new Error(`Invalid role ${role}`);
      }
    }
  }

  protected async init(argv?: GetConfigsArgv & { role: KeyRole[] }) {
    if (this.initialized) return;
    if (!argv) argv = await withAgentRole(withContext(getArgs())).argv;

    const { envConfig, agentConfig } = await getConfigsBasedOnArgs(argv);
    await assertCorrectKubeContext(envConfig);
    this.roles = argv.role;
    this.envConfig = envConfig;
    this.agentConfig = agentConfig;
    this.initialized = true;
  }

  private async runHelmCommandForValidators(command: HelmCommand) {
    await Promise.all(
      this.agentConfig.contextChainNames.map((chain) =>
        new ValidatorHelmManager(this.agentConfig, chain).runHelmCommand(
          command,
        ),
      ),
    );
  }
}
