import fs from 'fs';
import path from 'path';
import { ContractVerifier, VerificationInput } from '@abacus-network/deploy';
import { ChainName } from '@abacus-network/sdk';

import { DeployEnvironment } from './config';

export class AbacusContractVerifier extends ContractVerifier {
  constructor(
    public readonly environment: DeployEnvironment,
    public readonly deployType: string,
    public readonly key: string,
  ) {
    super(key);
  }

  get verificationDir(): string {
    const inputDir = '../config/environments';
    return path.join(
      inputDir,
      this.environment,
      this.deployType,
      'verification',
    );
  }

  get networks(): ChainName[] {
    const filenames = fs
      .readdirSync(this.verificationDir, { withFileTypes: true })
      .map((dirEntry: fs.Dirent) => dirEntry.name);

    return filenames.map((name) => name.split('.')[0] as ChainName);
  }

  getVerificationInput(network: ChainName): VerificationInput {
    const filename = `${network}.json`;
    const filepath = path.join(this.verificationDir, filename);
    if (!fs.existsSync(filepath)) {
      throw new Error(
        `No ${filename} files found for ${network} at ${this.verificationDir}`,
      );
    }

    const contents: string = fs.readFileSync(filepath).toString();

    return JSON.parse(contents) as VerificationInput;
  }
}
