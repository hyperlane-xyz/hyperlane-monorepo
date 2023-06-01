import {
  RelayerHelmManager,
  ScraperHelmManager,
  ValidatorHelmManager,
} from '../src/agents';
import { KeyRole } from '../src/agents/roles';
import { AgentConfig, EnvironmentConfig } from '../src/config';
import { HelmCommand } from '../src/utils/helm';

import {
  assertCorrectKubeContext,
  getArgs,
  getConfigsBasedOnArgs,
  withAgentRole,
  withContext,
} from './utils';

class Deployer {
  static async create(): Promise<Deployer> {
    const argv = await withAgentRole(withContext(getArgs())).argv;
    const { envConfig, agentConfig } = await getConfigsBasedOnArgs(argv);
    await assertCorrectKubeContext(envConfig);
    return new Deployer(argv.role, envConfig, agentConfig);
  }

  constructor(
    readonly roles: KeyRole[],
    readonly envConfig: EnvironmentConfig,
    readonly agentConfig: AgentConfig,
  ) {}

  async deploy() {
    await Promise.all(
      this.roles.map((role) => {
        switch (role) {
          case KeyRole.Validator:
            return this.deployValidators();
          case KeyRole.Relayer:
            return this.deployRelayer();
          case KeyRole.Scraper:
            return this.deployScraper();
          default:
            throw new Error(`Invalid role ${role}`);
        }
      }),
    );
  }

  async deployValidators() {
    await Promise.all(
      this.agentConfig.contextChainNames.map((chain) =>
        new ValidatorHelmManager(this.agentConfig, chain).runHelmCommand(
          HelmCommand.InstallOrUpgrade,
        ),
      ),
    );
  }

  async deployRelayer() {
    await new RelayerHelmManager(this.agentConfig).runHelmCommand(
      HelmCommand.InstallOrUpgrade,
    );
  }

  async deployScraper() {
    await new ScraperHelmManager(this.agentConfig).runHelmCommand(
      HelmCommand.InstallOrUpgrade,
    );
  }
}

// Note the create-keys script should be ran prior to running this script.
// At the moment, `runAgentHelmCommand` has the side effect of creating keys / users
// if they do not exist. It's possible for a race condition to occur where creation of
// a key / user that is used by multiple deployments (like Kathy),
// whose keys / users are not chain-specific) will be attempted multiple times.
// While this function still has these side effects, the workaround is to just
// run the create-keys script first.
async function main() {
  const d = await Deployer.create();
  await d.deploy();
}

main().then(console.log).catch(console.error);
