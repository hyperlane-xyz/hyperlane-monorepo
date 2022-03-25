import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { types } from '@abacus-network/utils';
import { ChainName } from '@abacus-network/sdk';

import { DeployEnvironment } from '../config';

import { ContractVerificationInput, VerificationInput } from './types';

const etherscanChains = [
  'ethereum',
  'kovan',
  'goerli',
  'ropsten',
  'rinkeby',
  'polygon',
];

export class ContractVerifier {
  constructor(
    public readonly environment: DeployEnvironment,
    public readonly deployType: string,
    public readonly key: string,
  ) {}

  get verificationDir(): string {
    const inputDir = '../../typescript/abacus-deploy/config/environments';
    return path.join(
      inputDir,
      this.environment,
      this.deployType,
      'verification',
    );
  }

  getNetworks(): ChainName[] {
    const filenames = fs
      .readdirSync(this.verificationDir, { withFileTypes: true })
      .map((dirEntry: fs.Dirent) => dirEntry.name);

    const chainNames: ChainName[] = [];
    for (const filename of filenames) {
      const tokens: string[] = filename.split('.');
      const chainName: ChainName = tokens[0] as ChainName;
      chainNames.push(chainName);
    }
    return chainNames;
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

  static etherscanLink(network: ChainName, address: types.Address) {
    if (network === 'polygon') {
      return `https://polygonscan.com/address/${address}`;
    }

    const prefix = network === 'ethereum' ? '' : `${network}.`;
    return `https://${prefix}etherscan.io/address/${address}`;
  }

  async verify(hre: any) {
    let network = hre.network.name;

    if (network === 'mainnet') {
      network = 'ethereum';
    }

    const envError = (network: string) =>
      `pass --network tag to hardhat task (current network=${network})`;

    // assert that network from .env is supported by Etherscan
    if (!etherscanChains.includes(network)) {
      throw new Error(
        `Network not supported by Etherscan; ${envError(network)}`,
      );
    }

    // get the JSON verification inputs for the given network
    // from the latest contract deploy; throw if not found
    const verificationInputs = this.getVerificationInput(network);

    // loop through each verification input for each contract in the file
    for (const verificationInput of verificationInputs) {
      // attempt to verify contract on etherscan
      // (await one-by-one so that Etherscan doesn't rate limit)
      await this.verifyContract(network, verificationInput, hre);
    }
  }

  async verifyContract(
    network: ChainName,
    input: ContractVerificationInput,
    hre: any,
  ) {
    try {
      console.log(
        `   Attempt to verify ${
          input.name
        }   -  ${ContractVerifier.etherscanLink(network, input.address)}`,
      );
      await hre.run('verify:verify', {
        network,
        address: input.address,
        constructorArguments: input.constructorArguments,
      });
      console.log(`   SUCCESS verifying ${input.name}`);

      if (input.isProxy) {
        console.log(`   Attempt to verify as proxy`);
        await this.verifyProxy(network, input.address);
        console.log(`   SUCCESS submitting proxy verification`);
      }
    } catch (e) {
      console.log(`   ERROR verifying ${input.name}`);
      console.error(e);
    }
    console.log('\n\n'); // add space after each attempt
  }

  async verifyProxy(network: ChainName, address: types.Address) {
    const suffix = network === 'ethereum' ? '' : `-${network}`;

    console.log(`   Submit ${address} for proxy verification on ${network}`);
    // Submit contract for verification
    const verifyResponse = await axios.post(
      `https://api${suffix}.etherscan.io/api`,
      `address=${address}`,
      {
        params: {
          module: 'contract',
          action: 'verifyproxycontract',
          apikey: this.key,
        },
      },
    );

    // Validate that submission worked
    if (verifyResponse.status !== 200) {
      throw new Error('Verify POST failed');
    } else if (verifyResponse.data.status != '1') {
      throw new Error(verifyResponse.data.result);
    }

    console.log(`   Submitted.`);
  }
}
