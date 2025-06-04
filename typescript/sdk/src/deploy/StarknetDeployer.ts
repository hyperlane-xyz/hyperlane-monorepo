import { BigNumber } from 'ethers';
import { Logger } from 'pino';
import {
  Account,
  BigNumberish,
  CallData,
  ContractFactory,
  ContractFactoryParams,
  MultiType,
  RawArgs,
} from 'starknet';

import {
  ContractType,
  getCompiledContract,
  getCompiledContractCasm,
} from '@hyperlane-xyz/starknet-core';
import {
  Address,
  ProtocolType,
  assert,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { HookType, ProtocolFeeHookConfig } from '../hook/types.js';
import { HookConfig } from '../hook/types.js';
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
import { PROTOCOL_TO_DEFAULT_NATIVE_TOKEN } from '../token/nativeTokenMetadata.js';
import { ChainName, ChainNameOrId } from '../types.js';
import {
  StarknetContractName,
  getStarknetIsmContract,
} from '../utils/starknet.js';

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
        `Deploying ${ismType} with deployer and burning ownership. ` +
          'Note: Unlike EVM, this ISM type is ownable on Starknet.',
      );
    }

    switch (ismType) {
      case IsmType.MERKLE_ROOT_MULTISIG:
      case IsmType.MESSAGE_ID_MULTISIG:
        constructorArgs = [
          '0x0000000000000000000000000000000000000000000000000000000000000001', // burn ownership but 0x0 fails zero address check in transfer_ownership
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

          this.logger.info(`ISM ${route} deployed for domain ${domainId}`);

          const tx = await routingContract.invoke('set', [domainId, route]);
          await this.account.waitForTransaction(tx.transaction_hash);
          this.logger.info(`ISM ${route} set for domain ${domainId}`);
        }
        return routingContract.address;
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
          '0x0000000000000000000000000000000000000000000000000000000000000001', // burn ownership but 0x0 fails zero address check in transfer_ownership
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

  async deployHook(
    chain: ChainNameOrId,
    hookConfig: HookConfig,
    mailboxAddress: Address,
    owner: Address,
  ): Promise<Address> {
    if (typeof hookConfig === 'string') {
      return hookConfig; // It's already an address
    }

    const chainName = this.multiProvider.getChainName(chain);
    this.logger.info(
      `Deploying ${hookConfig.type} hook on ${chainName} with owner ${owner}`,
    );

    let contractName: StarknetContractName;
    let constructorArgs: any[];

    switch (hookConfig.type) {
      case HookType.MERKLE_TREE:
        contractName = StarknetContractName.MERKLE_TREE_HOOK;
        constructorArgs = [mailboxAddress, owner];
        break;
      case HookType.PROTOCOL_FEE:
        // ProtocolFee is usually a required hook, set differently
        contractName = StarknetContractName.PROTOCOL_FEE;
        const pfConfig = hookConfig as ProtocolFeeHookConfig;
        constructorArgs = [
          BigNumber.from(pfConfig.maxProtocolFee),
          BigNumber.from(pfConfig.protocolFee),
          pfConfig.beneficiary,
          owner, // Owner of the fee contract itself
          PROTOCOL_TO_DEFAULT_NATIVE_TOKEN[ProtocolType.Starknet]!
            .denom as MultiType,
        ];
        break;
      default:
        throw new Error(
          `Unsupported hook type for deployment: ${hookConfig.type}`,
        );
    }
    return this.deployContract(contractName, constructorArgs);
  }
}
