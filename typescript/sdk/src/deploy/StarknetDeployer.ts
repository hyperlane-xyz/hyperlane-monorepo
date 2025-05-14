import { Logger } from 'pino';
import {
  Account,
  BigNumberish,
  CallData,
  ContractFactory,
  ContractFactoryParams,
  RawArgs,
} from 'starknet';

import {
  ContractType,
  getCompiledContract,
  getCompiledContractCasm,
} from '@hyperlane-xyz/starknet-contracts';
import { Address, assert, rootLogger } from '@hyperlane-xyz/utils';

import {
  StarknetIsmContractName,
  SupportedIsmTypesOnStarknet,
} from '../ism/starknet-utils.js';
import {
  IsmConfig,
  IsmType,
  SupportedIsmTypesOnStarknetType,
} from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName } from '../types.js';
import { getStarknetIsmContract } from '../utils/starknet.js';

export class StarknetDeployer {
  private readonly logger: Logger;
  private readonly deployedContracts: Record<string, string> = {};

  constructor(
    private readonly account: Account,
    private readonly multiProvider: MultiProvider,
  ) {
    this.logger = rootLogger.child({ module: 'starknet-deployer' });
  }

  async deployContract(
    contractName: string,
    constructorArgs: RawArgs,
    contractType?: ContractType,
  ): Promise<string> {
    this.logger.info(`Deploying contract ${contractName}...`);

    const compiledContract = getCompiledContract(contractName, contractType);
    const casm = getCompiledContractCasm(contractName, contractType);
    const constructorCalldata = CallData.compile(constructorArgs);

    const params: ContractFactoryParams = {
      compiledContract,
      account: this.account,
      casm,
    };

    const contractFactory = new ContractFactory(params);
    const contract = await contractFactory.deploy(constructorCalldata);
    const receipt = await this.account.waitForTransaction(
      contract.deployTransactionHash as BigNumberish,
    );

    assert(receipt.isSuccess(), `Contract ${contractName} deployment failed`);

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

  async deployIsm(params: {
    chain: ChainName;
    ismConfig: IsmConfig;
    mailbox: Address;
  }): Promise<Address> {
    const { chain, ismConfig, mailbox } = params;
    if (typeof ismConfig === 'string') {
      return ismConfig;
    }
    const ismType = ismConfig.type;
    this.logger.info(`Deploying ${ismType} to ${chain}`);

    assert(
      SupportedIsmTypesOnStarknet.includes(
        ismType as SupportedIsmTypesOnStarknetType,
      ),
      `ISM type ${ismType} is not supported on Starknet`,
    );

    const contractName =
      StarknetIsmContractName[ismType as SupportedIsmTypesOnStarknetType];
    let constructorArgs: RawArgs | undefined;

    // Log ownership model difference for ownable ISMs
    if (
      [
        IsmType.MERKLE_ROOT_MULTISIG,
        IsmType.MESSAGE_ID_MULTISIG,
        IsmType.AGGREGATION,
      ].includes(ismType)
    ) {
      this.logger.info(
        `Deploying ${ismType} with deployer (${this.account.address}) as initial owner. ` +
          'Note: Unlike EVM, this ISM type is ownable on Starknet and ownership can be transferred later.',
      );
    }

    switch (ismType) {
      case IsmType.MERKLE_ROOT_MULTISIG:
      case IsmType.MESSAGE_ID_MULTISIG:
        constructorArgs = [
          this.account.address,
          ismConfig.validators,
          ismConfig.threshold,
        ];

        break;
      case IsmType.ROUTING: {
        constructorArgs = [ismConfig.owner];
        const ismAddress = await this.deployContract(
          contractName,
          constructorArgs,
        );
        const routingContract = getStarknetIsmContract(
          IsmType.ROUTING,
          ismAddress,
          this.account,
        );
        const domains = ismConfig.domains;
        for (const domain of Object.keys(domains)) {
          const route = await this.deployIsm({
            chain,
            ismConfig: domains[domain],
            mailbox,
          });
          const domainId = this.multiProvider.getDomainId(domain);
          const tx = await routingContract.invoke('set', [
            BigInt(domainId),
            route,
          ]);
          await this.account.waitForTransaction(tx.transaction_hash);
          this.logger.info(`ISM ${route} set for domain ${domain}`);
        }

        return ismAddress;
      }
      case IsmType.PAUSABLE:
        constructorArgs = [ismConfig.owner];

        break;
      case IsmType.AGGREGATION: {
        const addresses: Address[] = [];
        for (const module of ismConfig.modules) {
          const submodule = await this.deployIsm({
            chain,
            ismConfig: module,
            mailbox,
          });
          addresses.push(submodule);
        }
        constructorArgs = [
          this.account.address,
          addresses,
          ismConfig.threshold,
        ];

        break;
      }
      case IsmType.TRUSTED_RELAYER:
        constructorArgs = [mailbox, ismConfig.relayer];
        break;
      case IsmType.FALLBACK_ROUTING:
        constructorArgs = [ismConfig.owner, mailbox];
        break;
      default:
        constructorArgs = undefined;
    }
    assert(
      contractName && constructorArgs,
      'ISM contract or constructor args are not provided',
    );
    return this.deployContract(contractName, constructorArgs);
  }
}
