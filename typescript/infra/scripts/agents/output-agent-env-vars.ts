import { ChainName } from '@hyperlane-xyz/sdk';

import {
  AgentHelmManager,
  RelayerHelmManager,
  ScraperHelmManager,
  ValidatorHelmManager,
} from '../../src/agents';
import { KeyRole } from '../../src/agents/roles';
import { getArgs, withContext, withKeyRoleAndChain } from '../utils';
import { writeFile } from 'fs/promises';

import { AgentCli } from './utils';

class EnvExporter extends AgentCli {
  file!: string;
  chain!: ChainName;
  index?: number;

  get role(): KeyRole {
    return this.roles[0];
  }

  async init() {
    if (this.initialized) return;
    const argv = await withKeyRoleAndChain(withContext(getArgs()))
      .string('file')
      .describe('file', 'path to write env vars to')
      .demandOption('file')
      .alias('f', 'file').argv;

    await super.init({ ...argv, role: [argv.role] });
    this.file = argv.file;
    this.chain = argv.chain;
    this.index = argv.index;
  }

  async writeEnvVars() {
    const envVars = await this.getEnvVars();
    await writeFile(this.file, envVars.join('\n'));
  }

  async getEnvVars(): Promise<string[]> {
    await this.init();
    return this.getManager().getEnvVars(this.index);
  }

  private getManager(): AgentHelmManager {
    switch (this.role) {
      case KeyRole.Validator:
        return new ValidatorHelmManager(this.agentConfig, this.chain);
      case KeyRole.Relayer:
        return new RelayerHelmManager(this.agentConfig);
      case KeyRole.Scraper:
        return new ScraperHelmManager(this.agentConfig);
      default:
        throw Error(`Invalid role ${this.role}`);
    }
  }
}

async function main() {
  await new EnvExporter().writeEnvVars();
}

main().then(console.log).catch(console.error);
