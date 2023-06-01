import { AllChains, ChainName } from '@hyperlane-xyz/sdk';

import {
  AgentEnvVars,
  AgentHelmManager,
  RelayerHelmManager,
  ScraperHelmManager,
  ValidatorHelmManager,
} from '../../src/agents';
import { Role } from '../../src/roles';
import { getArgs, withAgentRole, withContext } from '../utils';
import { writeFile } from 'fs/promises';

import { AgentCli } from './utils';

class EnvExporter extends AgentCli {
  file?: string;
  chain?: ChainName;
  index?: number;

  get role(): Role {
    return this.roles[0];
  }

  async init() {
    if (this.initialized) return;
    const argv = await withAgentRole(withContext(getArgs()))
      .string('file')
      .describe('file', 'path to write env vars to')
      .alias('f', 'file')

      .describe('chain', 'chain name')
      .choices('chain', AllChains)
      .alias('c', 'chain')

      .describe('index', 'index of role')
      .number('index')
      .alias('i', 'index')

      .check((argv) => {
        if (argv.role.length > 1) throw Error('only one role can be specified');
        if (
          argv.role[0] == Role.Validator &&
          (argv.index == undefined || argv.chain == undefined)
        )
          throw Error('chain and index must be defined for validator role');
        return true;
      }).argv;

    await super.init(argv);
    this.file = argv.file;
    this.chain = argv.chain;
    this.index = argv.index;
  }

  async writeEnvVars() {
    const envVars = await this.getEnvVars();
    await writeFile(
      this.file ??
        `${this.role}-${this.chain ?? 'omniscient'}-${this.index ?? 0}.env`,
      Object.entries(envVars)
        .map(
          ([key, value]) => `${key}='${value.toString().replace("'", "\\'")}'`,
        )
        .join('\n'),
    );
  }

  async getEnvVars(): Promise<AgentEnvVars> {
    await this.init();
    return this.getManager().getEnvVars(this.index);
  }

  async runBasedOnArgs() {
    await this.init();
    if (this.file) {
      await this.writeEnvVars();
    } else {
      console.log(await this.getEnvVars());
    }
  }

  private getManager(): AgentHelmManager {
    switch (this.role) {
      case Role.Validator:
        return new ValidatorHelmManager(this.agentConfig, this.chain!);
      case Role.Relayer:
        return new RelayerHelmManager(this.agentConfig);
      case Role.Scraper:
        return new ScraperHelmManager(this.agentConfig);
      default:
        throw Error(`Invalid role ${this.role}`);
    }
  }
}

async function main() {
  await new EnvExporter().runBasedOnArgs();
}

main().then(console.log).catch(console.error);
