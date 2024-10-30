import { Logger } from 'pino';
import {
  Account,
  CallData,
  ContractFactory,
  ContractFactoryParams,
} from 'starknet';

import {
  getCompiledContract,
  getCompiledContractCasm,
} from '@hyperlane-xyz/starknet-core';
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
  private readonly deployedContracts: Record<string, string> = {};

  constructor(
    private readonly account: Account,
    private readonly config: StarknetDeployConfig,
    private readonly options: StarknetDeployerOptions = {},
  ) {
    this.logger =
      options.logger ?? rootLogger.child({ module: 'starknet-deployer' });
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

  async deploy(): Promise<Record<string, string>> {
    try {
      for (const contractName of this.config.deploymentOrder) {
        await this.deployContract(
          contractName,
          this.config.contracts[contractName].constructor,
        );
      }

      this.logger.info(
        'All contracts deployed successfully:',
        this.deployedContracts,
      );

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
