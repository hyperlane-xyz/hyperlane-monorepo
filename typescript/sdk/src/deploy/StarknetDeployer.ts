import fs from 'fs';
import path from 'path';
import { Logger } from 'pino';
import {
  Account,
  CallData,
  ContractFactory,
  ContractFactoryParams,
} from 'starknet';
import { getCompiledContract, getCompiledContractCasm } from 'starknet-core';

import { rootLogger } from '@hyperlane-xyz/utils';

export interface StarknetContractConfig {
  name: string;
  constructor: Record<string, { type: string; value: string | string[] }>;
}

export interface StarknetDeployConfig {
  contracts: Record<string, StarknetContractConfig>;
  deploymentOrder: string[];
}

export interface StarknetDeployerOptions {
  logger?: Logger;
  deploymentsDir?: string;
  configsDir?: string;
  accountAddress?: string;
  network?: string;
}

export class StarknetDeployer {
  private readonly logger: Logger;
  private readonly deploymentsDir: string;
  private readonly configsDir: string;
  private readonly deployedContracts: Record<string, string> = {};

  constructor(
    private readonly account: Account,
    private readonly options: StarknetDeployerOptions = {},
  ) {
    this.logger =
      options.logger ?? rootLogger.child({ module: 'starknet-deployer' });
    this.deploymentsDir = options.deploymentsDir ?? 'deployments';
    this.configsDir = options.configsDir ?? 'configs';
  }

  private processConstructorArgs(
    args: Record<string, { type: string; value: string | string[] }>,
  ): any {
    return Object.entries(args).reduce((acc, [key, { type, value }]) => {
      if (typeof value === 'string' && value.startsWith('$')) {
        if (value === '$OWNER_ADDRESS') {
          acc[key] = this.options.accountAddress;
        } else if (value === '$BENEFICIARY_ADDRESS') {
          acc[key] = process.env.BENEFICIARY_ADDRESS;
        } else {
          const contractName = value.slice(1);
          if (this.deployedContracts[contractName]) {
            acc[key] = this.deployedContracts[contractName];
          } else {
            throw new Error(
              `Contract ${contractName} not yet deployed, required for ${key}`,
            );
          }
        }
      } else {
        acc[key] = value;
      }
      return acc;
    }, {} as any);
  }

  private ensureNetworkDirectory(network: string): string {
    if (!network) {
      throw new Error('Network must be specified');
    }

    const networkDir = path.join(this.deploymentsDir, network);
    if (!fs.existsSync(this.deploymentsDir)) {
      fs.mkdirSync(this.deploymentsDir);
    }
    if (!fs.existsSync(networkDir)) {
      fs.mkdirSync(networkDir);
    }

    return networkDir;
  }

  private getConfigPath(network: string): string {
    if (!network) {
      throw new Error('Network must be specified');
    }

    const configFileName = `${network.toLowerCase()}.json`;
    const configPath = path.join(this.configsDir, configFileName);

    if (!fs.existsSync(configPath)) {
      throw new Error(
        `Config file not found for network ${network} at ${configPath}`,
      );
    }

    return configPath;
  }

  async deployContract(
    contractName: string,
    constructorArgs: StarknetContractConfig['constructor'],
  ): Promise<string> {
    this.logger.info(`Deploying contract ${contractName}...`);

    const compiledContract = getCompiledContract(contractName);
    const casm = getCompiledContractCasm(contractName);
    const processedArgs = this.processConstructorArgs(constructorArgs);
    const constructorCalldata = CallData.compile(processedArgs);

    const params: ContractFactoryParams = {
      compiledContract,
      account: this.account,
      casm,
    };

    const contractFactory = new ContractFactory(params);
    const contract = await contractFactory.deploy(constructorCalldata);

    let address = contract.address;
    // Ensure the address is 66 characters long (including the '0x' prefix)
    if (address.length < 66) {
      address = '0x' + address.slice(2).padStart(64, '0');
    }

    this.logger.info(
      `Contract ${contractName} deployed at address: ${address}`,
    );
    this.deployedContracts[contractName] = address;

    return address;
  }

  async deploy(network: string): Promise<Record<string, string>> {
    try {
      const configPath = this.getConfigPath(network);
      const config: StarknetDeployConfig = JSON.parse(
        fs.readFileSync(configPath, 'utf-8'),
      );

      const networkDir = this.ensureNetworkDirectory(network);
      const deploymentsFile = path.join(networkDir, 'deployments.json');

      for (const contractName of config.deploymentOrder) {
        await this.deployContract(
          contractName,
          config.contracts[contractName].constructor,
        );
      }

      this.logger.info(
        'All contracts deployed successfully:',
        this.deployedContracts,
      );

      // Write deployments to network-specific file
      fs.writeFileSync(
        deploymentsFile,
        JSON.stringify(this.deployedContracts, null, 2),
      );
      this.logger.info(`Deployed contracts saved to ${deploymentsFile}`);

      return this.deployedContracts;
    } catch (error) {
      this.logger.error('Deployment failed:', error);
      throw error;
    }
  }

  getDeployedContracts(): Record<string, string> {
    return { ...this.deployedContracts };
  }
}
