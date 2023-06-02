import {
  RelayerHelmManager,
  ScraperHelmManager,
  ValidatorHelmManager,
} from '../../src/agents';
import { AgentConfig, EnvironmentConfig } from '../../src/config';
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
  agentConfig!: AgentConfig;
  initialized = false;

  public async runHelmCommand(command: HelmCommand) {
    await this.init();
    for (const role of this.roles) {
      switch (role) {
        case Role.Validator:
          await this.runHelmCommandForValidators(command);
          break;
        case Role.Relayer:
          await new RelayerHelmManager(this.agentConfig).runHelmCommand(
            command,
          );
          break;
        case Role.Scraper:
          await new ScraperHelmManager(this.agentConfig).runHelmCommand(
            command,
          );
          break;
        default:
          throw new Error(`Invalid role ${role}`);
      }
    }
  }

  protected async init(argv?: GetConfigsArgv & { role: Role[] }) {
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
      (this.agentConfig.validators?.contextChainNames ?? []).map((chain) =>
        new ValidatorHelmManager(this.agentConfig, chain).runHelmCommand(
          command,
        ),
      ),
    );
  }
}
