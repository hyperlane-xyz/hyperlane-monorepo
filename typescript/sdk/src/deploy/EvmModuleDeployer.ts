import { ethers } from 'ethers';
import { Logger } from 'pino';

import {
  StaticAddressSetFactory,
  StaticThresholdAddressSetFactory,
  TransparentUpgradeableProxy__factory,
} from '@hyperlane-xyz/core';
import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneContracts, HyperlaneFactories } from '../contracts/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap, ChainName } from '../types.js';

import { isProxy, proxyConstructorArgs } from './proxy.js';
import { ContractVerifier } from './verify/ContractVerifier.js';
import {
  ContractVerificationInput,
  ExplorerLicenseType,
} from './verify/types.js';
import { getContractVerificationInput } from './verify/utils.js';

export class EvmModuleDeployer<Factories extends HyperlaneFactories> {
  public verificationInputs: ChainMap<ContractVerificationInput[]> = {};

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly factories: Factories,
    protected readonly logger = rootLogger.child({
      module: 'EvmModuleDeployer',
    }),
    protected readonly contractVerifier?: ContractVerifier,
  ) {
    this.contractVerifier ??= new ContractVerifier(
      multiProvider,
      {},
      coreBuildArtifact,
      ExplorerLicenseType.MIT,
    );
  }

  // Deploys a contract from a factory
  public async deployContractFromFactory<F extends ethers.ContractFactory>({
    chain,
    factory,
    contractName,
    constructorArgs,
    initializeArgs,
    implementationAddress,
  }: {
    chain: ChainName;
    factory: F;
    contractName: string;
    constructorArgs: Parameters<F['deploy']>;
    initializeArgs?: Parameters<Awaited<ReturnType<F['deploy']>>['initialize']>;
    implementationAddress?: Address;
  }): Promise<ReturnType<F['deploy']>> {
    this.logger.info(
      `Deploying ${contractName} on ${chain} with constructor args (${constructorArgs.join(
        ', ',
      )})...`,
    );
    const contract = await this.multiProvider.handleDeploy(
      chain,
      factory,
      constructorArgs,
    );

    if (initializeArgs) {
      this.logger.debug(`Initialize ${contractName} on ${chain}`);
      const overrides = this.multiProvider.getTransactionOverrides(chain);
      const initTx = await contract.initialize(...initializeArgs, overrides);
      await this.multiProvider.handleTx(chain, initTx);
    }

    const verificationInput = getContractVerificationInput({
      name: contractName,
      contract,
      bytecode: factory.bytecode,
      expectedimplementation: implementationAddress,
    });
    this.addVerificationArtifacts({ chain, artifacts: [verificationInput] });

    // try verifying contract
    try {
      await this.contractVerifier?.verifyContract(chain, verificationInput);
    } catch (error) {
      // log error but keep deploying, can also verify post-deployment if needed
      this.logger.debug(`Error verifying contract: ${error}`);
    }

    return contract;
  }

  /**
   * Deploys a contract with a specified name.
   *
   * This function is capable of deploying any contract type defined within the `Factories` type to a specified chain.
   *
   * @param {ChainName} chain - The name of the chain on which the contract is to be deployed.
   * @param {K} contractKey - The key identifying the factory to use for deployment.
   * @param {string} contractName - The name of the contract to deploy. This must match the contract source code.
   * @param {Parameters<Factories[K]['deploy']>} constructorArgs - Arguments for the contract's constructor.
   * @param {Parameters<Awaited<ReturnType<Factories[K]['deploy']>>['initialize']>?} initializeArgs - Optional arguments for the contract's initialization function.
   * @returns {Promise<HyperlaneContracts<Factories>[K]>} A promise that resolves to the deployed contract instance.
   */
  public async deployContractWithName<K extends keyof Factories>({
    chain,
    contractKey,
    contractName,
    constructorArgs,
    initializeArgs,
  }: {
    chain: ChainName;
    contractKey: K;
    contractName: string;
    constructorArgs: Parameters<Factories[K]['deploy']>;
    initializeArgs?: Parameters<
      Awaited<ReturnType<Factories[K]['deploy']>>['initialize']
    >;
  }): Promise<HyperlaneContracts<Factories>[K]> {
    const contract = await this.deployContractFromFactory({
      chain,
      factory: this.factories[contractKey],
      contractName,
      constructorArgs,
      initializeArgs,
    });
    return contract;
  }

  // Deploys a contract with the same name as the contract key
  public async deployContract<K extends keyof Factories>({
    chain,
    contractKey,
    constructorArgs,
    initializeArgs,
  }: {
    chain: ChainName;
    contractKey: K;
    constructorArgs: Parameters<Factories[K]['deploy']>;
    initializeArgs?: Parameters<
      Awaited<ReturnType<Factories[K]['deploy']>>['initialize']
    >;
  }): Promise<HyperlaneContracts<Factories>[K]> {
    return this.deployContractWithName({
      chain,
      contractKey,
      contractName: contractKey.toString(),
      constructorArgs,
      initializeArgs,
    });
  }

  // Deploys the Implementation and Proxy for a given contract
  public async deployProxiedContract<K extends keyof Factories>({
    chain,
    contractKey,
    contractName,
    proxyAdmin,
    constructorArgs,
    initializeArgs,
  }: {
    chain: ChainName;
    contractKey: K;
    contractName: string;
    proxyAdmin: string;
    constructorArgs: Parameters<Factories[K]['deploy']>;
    initializeArgs?: Parameters<HyperlaneContracts<Factories>[K]['initialize']>;
  }): Promise<HyperlaneContracts<Factories>[K]> {
    // Try to initialize the implementation even though it may not be necessary
    const implementation = await this.deployContractWithName({
      chain,
      contractKey,
      contractName,
      constructorArgs,
      initializeArgs,
    });

    // Initialize the proxy the same way
    return this.deployProxy({
      chain,
      implementation,
      proxyAdmin,
      initializeArgs,
    });
  }

  // Deploys a proxy for a given implementation contract
  protected async deployProxy<C extends ethers.Contract>({
    chain,
    implementation,
    proxyAdmin,
    initializeArgs,
  }: {
    chain: ChainName;
    implementation: C;
    proxyAdmin: string;
    initializeArgs?: Parameters<C['initialize']>;
  }): Promise<C> {
    const isProxied = await isProxy(
      this.multiProvider.getProvider(chain),
      implementation.address,
    );
    if (isProxied) {
      // if the implementation is already a proxy, do not deploy a new proxy
      return implementation;
    }

    const constructorArgs = proxyConstructorArgs(
      implementation,
      proxyAdmin,
      initializeArgs,
    );
    const proxy = await this.deployContractFromFactory({
      chain,
      factory: new TransparentUpgradeableProxy__factory(),
      contractName: 'TransparentUpgradeableProxy',
      constructorArgs,
      implementationAddress: implementation.address,
    });

    return implementation.attach(proxy.address) as C;
  }

  // Adds verification artifacts to the verificationInputs map
  protected addVerificationArtifacts({
    chain,
    artifacts,
  }: {
    chain: ChainName;
    artifacts: ContractVerificationInput[];
  }): void {
    this.verificationInputs[chain] = this.verificationInputs[chain] || [];
    artifacts.forEach((artifact) => {
      this.verificationInputs[chain].push(artifact);
    });
  }

  // Static deploy function used by Hook and ISM modules.
  public static async deployStaticAddressSet({
    chain,
    factory,
    values,
    logger,
    threshold = values.length,
    multiProvider,
  }: {
    chain: ChainName;
    factory: StaticThresholdAddressSetFactory | StaticAddressSetFactory;
    values: Address[];
    logger: Logger;
    threshold?: number;
    multiProvider: MultiProvider;
  }): Promise<Address> {
    const address = await factory['getAddress(address[],uint8)'](
      values,
      threshold,
    );
    const code = await multiProvider.getProvider(chain).getCode(address);
    if (code === '0x') {
      logger.debug(
        `Deploying new ${threshold} of ${values.length} address set to ${chain}`,
      );
      const overrides = multiProvider.getTransactionOverrides(chain);

      // estimate gas
      const estimatedGas = await factory.estimateGas['deploy(address[],uint8)'](
        values,
        threshold,
        overrides,
      );

      // add 10% buffer
      const hash = await factory['deploy(address[],uint8)'](values, threshold, {
        ...overrides,
        gasLimit: estimatedGas.add(estimatedGas.div(10)), // 10% buffer
      });

      await multiProvider.handleTx(chain, hash);
    } else {
      logger.debug(
        `Recovered ${threshold} of ${values.length} address set on ${chain}: ${address}`,
      );
    }

    // TODO: figure out how to get the constructor arguments for manual deploy TXs
    // const verificationInput = buildVerificationInput(
    //   NAME,
    //   ADDRESS,
    //   CONSTRUCTOR_ARGS,
    // );
    // await this.deployer.verifyContract(
    //   this.chainName,
    //   verificationInput,
    //   logger,
    // );

    return address;
  }
}
