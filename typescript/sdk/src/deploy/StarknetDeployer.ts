import { BigNumber } from 'ethers';
import { Logger } from 'pino';
import {
  Account,
  CallData,
  ContractFactory,
  ContractFactoryParams,
  MultiType,
  RawArgs,
  UniversalDeployerContractPayload,
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

import { HookConfig, HookType, ProtocolFeeHookConfig } from '../hook/types.js';
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

  constructor(
    private readonly account: Account,
    private readonly multiProvider: MultiProvider,
  ) {
    this.logger = rootLogger.child({ module: 'starknet-deployer' });
  }

  async deployContracts(
    contracts: {
      contractName: string;
      constructorArgs: RawArgs;
      contractType?: ContractType;
    }[],
  ): Promise<string[]> {
    this.logger.info(`Deploying multiple contractcs: ${contracts.length}...`);

    const deployParams: UniversalDeployerContractPayload[] = [];

    const declared = new Map<string, string>();

    for (const { contractName, constructorArgs, contractType } of contracts) {
      const compiledContract = getCompiledContract(contractName, contractType);
      const casm = getCompiledContractCasm(contractName, contractType);
      const constructorCalldata = CallData.compile(constructorArgs);

      const params: ContractFactoryParams = {
        compiledContract,
        account: this.account,
        casm,
      };

      // don't have to ensure declaration of a contract that has already been declared for sure
      if (declared.has(contractName)) {
        deployParams.push({
          classHash: declared.get(contractName)!,
          constructorCalldata: constructorCalldata,
        });
        continue;
      }

      this.logger.info(`Declaring contract: ${contractName}`);
      const declaration = await this.account.declareIfNot({
        contract: params.compiledContract,
        casm: params.casm,
        classHash: params.classHash,
        compiledClassHash: params.compiledClassHash,
      });

      declared.set(contractName, declaration.class_hash);

      deployParams.push({
        classHash: declaration.class_hash,
        constructorCalldata: constructorCalldata,
      });
    }

    this.logger.info(`Doing batch deploy call...`);
    const deployment = await this.account.deploy(deployParams);
    await this.account.waitForTransaction(deployment.transaction_hash);

    const addresses = deployment.contract_address.map((x) => {
      if (x.length < 66) '0x' + x.slice(2).padStart(64, '0');
      return x;
    });

    this.logger.info(`Contracts deployed at address: ${addresses}`);
    return addresses;
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
    let address = contract.address;

    // Ensure the address is 66 characters long (including the '0x' prefix)
    if (address.length < 66) {
      address = '0x' + address.slice(2).padStart(64, '0');
    }

    this.logger.info(
      `Contract ${contractName} deployed at address: ${address}`,
    );

    return address;
  }

  async deployIsms(
    params: Array<{ chain: ChainName; ismConfig: IsmConfig; mailbox: Address }>,
  ): Promise<Address[]> {
    const contracts: {
      contractName: string;
      constructorArgs: RawArgs;
      contractType?: ContractType;
    }[] = [];
    // array to keep deployment order inplace
    // we might destroy the order if we have a mix of parallized and unparallized deployments
    // either the addresse directly or the index into the parallel deployed addresses
    const indicies: (number | string)[] = [];

    for (let i = 0; i < params.length; i++) {
      const contract = params[i];
      // if the contract can not be deployed in parallel
      if (
        typeof contract.ismConfig === 'string' ||
        (contract.ismConfig.type != IsmType.MERKLE_ROOT_MULTISIG &&
          contract.ismConfig.type != IsmType.MESSAGE_ID_MULTISIG)
      ) {
        indicies.push(await this.deployIsm(contract));
        continue;
      }

      const constructorArgs = [
        this.account.address,
        contract.ismConfig.validators,
        contract.ismConfig.threshold,
      ];

      const contractName =
        StarknetIsmContractName[
          contract.ismConfig.type as SupportedIsmTypesOnStarknetType
        ];

      indicies.push(contracts.length);
      contracts.push({ contractName, constructorArgs });
    }

    // deploy remaining contracts in parallel
    const deployedAddresses = await this.deployContracts(contracts);

    const result = indicies.map((x) => {
      if (typeof x === 'number') return deployedAddresses[x];
      return x;
    });
    return result;
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

    switch (ismType) {
      case IsmType.MERKLE_ROOT_MULTISIG:
      case IsmType.MESSAGE_ID_MULTISIG:
        // 0x1 to make mutlsigs immutable and not owned
        constructorArgs = ['0x1', ismConfig.validators, ismConfig.threshold];
        break;
      case IsmType.ROUTING: {
        // initialize the contract with the deployer as the owner to later transfer ownership
        constructorArgs = [this.account.address];
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
        const domainIds = [];
        const subIsms = [];
        for (const domain of Object.keys(domains)) {
          subIsms.push({ chain, ismConfig: domains[domain], mailbox });
          const domainId = this.multiProvider.getDomainId(domain);
          domainIds.push(domainId);
        }
        const routes = await this.deployIsms(subIsms);
        const calls = [];
        // setting the routes in a single transaction
        for (let i = 0; i < domainIds.length; i++) {
          calls.push(
            routingContract.populate('set', [domainIds[i], routes[i]]),
          );
        }
        const result = await this.account.execute(calls);
        await this.account.waitForTransaction(result.transaction_hash);
        this.logger.info(`ISM ${routes} set for domains ${domainIds}`);

        // transfer ownership once configuration is done
        if (ismConfig.owner != this.account.address) {
          const transfer = await routingContract.invoke('transfer_ownership', [
            ismConfig.owner,
          ]);
          await this.account.waitForTransaction(transfer.transaction_hash);
        }

        return ismAddress;
      }
      case IsmType.PAUSABLE:
        constructorArgs = [ismConfig.owner];
        break;
      case IsmType.AGGREGATION: {
        const addresses = await this.deployIsms(
          ismConfig.modules.map((x) => ({ chain, ismConfig: x, mailbox })),
        );

        // make aggregationIsm immutable
        constructorArgs = ['0x1', addresses, ismConfig.threshold];

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
      case HookType.PROTOCOL_FEE: {
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
      }
      default:
        throw new Error(
          `Unsupported hook type for deployment: ${hookConfig.type}`,
        );
    }
    return this.deployContract(contractName, constructorArgs);
  }
}
