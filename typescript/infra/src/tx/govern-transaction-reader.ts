import { Result } from '@ethersproject/abi';
import { decodeMultiSendData } from '@safe-global/protocol-kit/dist/src/utils/index.js';
import {
  MetaTransactionData,
  OperationType,
} from '@safe-global/safe-core-sdk-types';
import assert from 'assert';
import chalk from 'chalk';
import { BigNumber, ethers } from 'ethers';

import {
  Ownable__factory,
  ProxyAdmin__factory,
  TimelockController__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import {
  AnnotatedEV5Transaction,
  ChainMap,
  ChainName,
  CoreConfig,
  DerivedIsmConfig,
  EvmIsmReader,
  InterchainAccount,
  MultiProvider,
  WarpCoreConfig,
  coreFactories,
  interchainAccountFactories,
  normalizeConfig,
} from '@hyperlane-xyz/sdk';
import {
  addressToBytes32,
  bytes32ToAddress,
  deepEquals,
  eqAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  icaOwnerChain,
  icas,
  safes,
  timelocks,
} from '../../config/environments/mainnet3/owners.js';
import { DeployEnvironment } from '../config/environment.js';
import { getSafeAndService } from '../utils/safe.js';

interface GovernTransaction extends Record<string, any> {
  chain: ChainName;
}

interface MultiSendTransaction {
  index: number;
  value: string;
  operation: string;
  decoded: GovernTransaction;
}

interface MultiSendGovernTransactions extends GovernTransaction {
  multisends: MultiSendTransaction[];
}

interface SetDefaultIsmInsight {
  module: string;
  insight: string;
}

interface IcaRemoteCallInsight {
  destination: {
    domain: number;
    chain: ChainName;
  };
  router: {
    address: string;
    insight: string;
  };
  ism: {
    address: string;
    insight: string;
  };
  destinationIca: {
    address: string;
    insight: string;
  };
  calls: GovernTransaction[];
}

export class GovernTransactionReader {
  errors: any[] = [];

  protected readonly logger = rootLogger.child({
    module: 'GovernTransactionReader',
  });

  readonly warpRouteIndex: ChainMap<
    Record<string, WarpCoreConfig['tokens'][number]>
  > = {};

  constructor(
    readonly environment: DeployEnvironment,
    readonly multiProvider: MultiProvider,
    readonly chainAddresses: ChainMap<Record<string, string>>,
    readonly coreConfig: ChainMap<CoreConfig>,
    warpRoutes: Record<string, WarpCoreConfig>,
  ) {
    // Populate maps with warp route addresses and additional token details
    for (const warpRoute of Object.values(warpRoutes)) {
      for (const token of Object.values(warpRoute.tokens)) {
        const address = token.addressOrDenom?.toLowerCase() ?? '';
        if (!this.warpRouteIndex[token.chainName]) {
          this.warpRouteIndex[token.chainName] = {};
        }
        this.warpRouteIndex[token.chainName][address] = token;
      }
    }
  }

  async read(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<GovernTransaction> {
    // If it's to an ICA
    if (this.isIcaTransaction(chain, tx)) {
      return this.readIcaTransaction(chain, tx);
    }

    // If it's to a Mailbox
    if (this.isMailboxTransaction(chain, tx)) {
      return this.readMailboxTransaction(chain, tx);
    }

    // If it's to a Proxy Admin
    if (this.isProxyAdminTransaction(chain, tx)) {
      return this.readProxyAdminTransaction(chain, tx);
    }

    // If it's to a TimelockController
    if (this.isTimelockControllerTransaction(chain, tx)) {
      return this.readTimelockControllerTransaction(chain, tx);
    }

    // If it's a Multisend
    if (await this.isMultisendTransaction(chain, tx)) {
      return this.readMultisendTransaction(chain, tx);
    }

    // If it's a Warp Module transaction
    if (this.isWarpModuleTransaction(chain, tx)) {
      return this.readWarpModuleTransaction(chain, tx);
    }

    // If it's an Ownable transaction
    if (await this.isOwnableTransaction(chain, tx)) {
      return this.readOwnableTransaction(chain, tx);
    }

    // If it's a native token transfer (no data, only value)
    if (this.isNativeTokenTransfer(tx)) {
      return this.readNativeTokenTransfer(chain, tx);
    }

    const insight = '⚠️ Unknown transaction type';
    // If we get here, it's an unknown transaction
    this.errors.push({
      chain: chain,
      tx,
      info: insight,
    });

    return {
      chain,
      insight,
      tx,
    };
  }

  private isNativeTokenTransfer(tx: AnnotatedEV5Transaction): boolean {
    return !tx.data && !!tx.value && !!tx.to;
  }

  private async readNativeTokenTransfer(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<GovernTransaction> {
    const { symbol } = await this.multiProvider.getNativeToken(chain);
    const numTokens = ethers.utils.formatEther(tx.value ?? BigNumber.from(0));
    return {
      chain,
      insight: `Send ${numTokens} ${symbol} to ${tx.to}`,
      tx,
    };
  }

  private isTimelockControllerTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): boolean {
    return (
      tx.to !== undefined &&
      timelocks[chain] !== undefined &&
      eqAddress(tx.to!, timelocks[chain]!)
    );
  }

  private async readTimelockControllerTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<GovernTransaction> {
    if (!tx.data) {
      throw new Error('No data in TimelockController transaction');
    }

    const timelockControllerInterface =
      TimelockController__factory.createInterface();
    const decoded = timelockControllerInterface.parseTransaction({
      data: tx.data,
      value: tx.value,
    });

    let insight;
    if (
      decoded.functionFragment.name ===
      timelockControllerInterface.functions[
        'schedule(address,uint256,bytes,bytes32,bytes32,uint256)'
      ].name
    ) {
      const [target, value, data, _predecessor, _salt, delay] = decoded.args;
      const inner = await this.read(chain, {
        to: target,
        data,
        value,
      });

      const eta = new Date(Date.now() + delay.toNumber() * 1000);

      insight = `Schedule for ${eta}: ${JSON.stringify(inner)}`;
    }

    if (
      decoded.functionFragment.name ===
      timelockControllerInterface.functions[
        'execute(address,uint256,bytes,bytes32,bytes32)'
      ].name
    ) {
      const [target, value, data, executor] = decoded.args;
      insight = `Execute ${target} with ${value} ${data}. Executor: ${executor}`;
    }

    if (
      decoded.functionFragment.name ===
      timelockControllerInterface.functions['cancel(bytes32)'].name
    ) {
      const [id] = decoded.args;
      insight = `Cancel scheduled transaction ${id}`;
    }

    const args = formatFunctionFragmentArgs(
      decoded.args,
      decoded.functionFragment,
    );

    return {
      chain,
      to: `Timelock Controller (${chain} ${tx.to})`,
      ...(insight ? { insight } : { args }),
    };
  }

  private isWarpModuleTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): boolean {
    return (
      tx.to !== undefined &&
      this.warpRouteIndex[chain] !== undefined &&
      this.warpRouteIndex[chain][tx.to.toLowerCase()] !== undefined
    );
  }

  private async readWarpModuleTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<GovernTransaction> {
    if (!tx.data) {
      throw new Error('No data in Warp Module transaction');
    }

    const { symbol } = await this.multiProvider.getNativeToken(chain);
    const tokenRouterInterface = TokenRouter__factory.createInterface();

    const decoded = tokenRouterInterface.parseTransaction({
      data: tx.data,
      value: tx.value,
    });

    let insight;
    if (
      decoded.functionFragment.name ===
      tokenRouterInterface.functions['setHook(address)'].name
    ) {
      const [hookAddress] = decoded.args;
      insight = `Set hook to ${hookAddress}`;
    }

    if (
      decoded.functionFragment.name ===
      tokenRouterInterface.functions['setInterchainSecurityModule(address)']
        .name
    ) {
      const [ismAddress] = decoded.args;
      insight = `Set ISM to ${ismAddress}`;
    }

    if (
      decoded.functionFragment.name ===
      tokenRouterInterface.functions['setDestinationGas((uint32,uint256)[])']
        .name
    ) {
      const [gasConfigs] = decoded.args;
      const insights = gasConfigs.map(
        (config: { domain: number; gas: BigNumber }) => {
          const chainName = this.multiProvider.getChainName(config.domain);
          return `domain ${
            config.domain
          } (${chainName}) to ${config.gas.toString()}`;
        },
      );
      insight = `Set destination gas for ${insights.join(', ')}`;
    }

    if (
      decoded.functionFragment.name ===
      tokenRouterInterface.functions['enrollRemoteRouters(uint32[],bytes32[])']
        .name
    ) {
      const [domains, routers] = decoded.args;
      const insights = domains.map((domain: number, index: number) => {
        const chainName = this.multiProvider.getChainName(domain);
        return `domain ${domain} (${chainName}) to ${routers[index]}`;
      });
      insight = `Enroll remote routers for ${insights.join(', ')}`;
    }

    if (
      decoded.functionFragment.name ===
      tokenRouterInterface.functions['unenrollRemoteRouter(uint32)'].name
    ) {
      const [domain] = decoded.args;
      const chainName = this.multiProvider.getChainName(domain);
      insight = `Unenroll remote router for domain ${domain} (${chainName})`;
    }

    if (
      decoded.functionFragment.name ===
      tokenRouterInterface.functions['unenrollRemoteRouters(uint32[])'].name
    ) {
      const [domains] = decoded.args;
      const insights = domains.map((domain: number) => {
        const chainName = this.multiProvider.getChainName(domain);
        return `domain ${domain} (${chainName})`;
      });
      insight = `Unenroll remote routers for ${insights.join(', ')}`;
    }

    let ownableTx = {};
    if (!insight) {
      ownableTx = await this.readOwnableTransaction(chain, tx);
    }

    assert(tx.to, 'Warp Module transaction must have a to address');
    const tokenAddress = tx.to.toLowerCase();
    const token = this.warpRouteIndex[chain][tokenAddress];

    return {
      ...ownableTx,
      chain,
      to: `${token.symbol} (${token.name}, ${token.standard}, ${tokenAddress})`,
      insight,
      value: `${ethers.utils.formatEther(decoded.value)} ${symbol}`,
      signature: decoded.signature,
    };
  }

  private async readIcaTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<GovernTransaction> {
    if (!tx.data) {
      throw new Error('No data in ICA transaction');
    }
    const { symbol } = await this.multiProvider.getNativeToken(chain);
    const icaInterface =
      interchainAccountFactories.interchainAccountRouter.interface;
    const decoded = icaInterface.parseTransaction({
      data: tx.data,
      value: tx.value,
    });

    const args = formatFunctionFragmentArgs(
      decoded.args,
      decoded.functionFragment,
    );
    let prettyArgs = args;

    if (
      decoded.functionFragment.name ===
      icaInterface.functions['enrollRemoteRouter(uint32,bytes32)'].name
    ) {
      prettyArgs = await this.formatRouterEnrollments(
        chain,
        'interchainAccountRouter',
        args,
      );
    } else if (
      decoded.functionFragment.name ===
      icaInterface.functions[
        'callRemoteWithOverrides(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[])'
      ].name
    ) {
      prettyArgs = await this.readIcaRemoteCall(chain, args);
    }

    return {
      to: `ICA Router (${chain} ${this.chainAddresses[chain].interchainAccountRouter})`,
      value: `${ethers.utils.formatEther(decoded.value)} ${symbol}`,
      signature: decoded.signature,
      args: prettyArgs,
      chain,
    };
  }

  private async formatRouterEnrollments(
    chain: ChainName,
    routerName: string,
    args: Record<string, any>,
  ): Promise<GovernTransaction> {
    const { _domains: domains, _addresses: addresses } = args;
    return domains.map((domain: number, index: number) => {
      const remoteChainName = this.multiProvider.getChainName(domain);
      const expectedRouter = this.chainAddresses[remoteChainName][routerName];
      const routerToBeEnrolled = addresses[index];
      const matchesExpectedRouter =
        eqAddress(expectedRouter, bytes32ToAddress(routerToBeEnrolled)) &&
        // Poor man's check that the 12 byte padding is all zeroes
        addressToBytes32(bytes32ToAddress(routerToBeEnrolled)) ===
          routerToBeEnrolled;

      let insight = '✅ matches expected router from artifacts';
      if (!matchesExpectedRouter) {
        insight = `❌ fatal mismatch, expected ${expectedRouter}`;
        this.errors.push({
          chain: chain,
          remoteDomain: domain,
          remoteChain: remoteChainName,
          router: routerToBeEnrolled,
          expected: expectedRouter,
          info: 'Incorrect router getting enrolled',
        });
      }

      return {
        domain: domain,
        chainName: remoteChainName,
        router: routerToBeEnrolled,
        insight,
      };
    });
  }

  private async readMailboxTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<GovernTransaction> {
    if (!tx.data) {
      throw new Error('⚠️ No data in mailbox transaction');
    }
    const mailboxInterface = coreFactories.mailbox.interface;
    const decoded = mailboxInterface.parseTransaction({
      data: tx.data,
      value: tx.value,
    });

    const args = formatFunctionFragmentArgs(
      decoded.args,
      decoded.functionFragment,
    );
    let prettyArgs = args;
    if (
      decoded.functionFragment.name ===
      mailboxInterface.functions['setDefaultIsm(address)'].name
    ) {
      prettyArgs = await this.formatMailboxSetDefaultIsm(chain, args);
    }

    return {
      chain,
      to: `Mailbox (${chain} ${this.chainAddresses[chain].mailbox})`,
      signature: decoded.signature,
      args: prettyArgs,
    };
  }

  private async readProxyAdminTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<GovernTransaction> {
    if (!tx.data) {
      throw new Error('⚠️ No data in proxyAdmin transaction');
    }

    const proxyAdminInterface = ProxyAdmin__factory.createInterface();
    const decoded = proxyAdminInterface.parseTransaction({
      data: tx.data,
      value: tx.value,
    });

    const ownableTx = await this.readOwnableTransaction(chain, tx);
    return {
      ...ownableTx,
      to: `Proxy Admin (${chain} ${this.chainAddresses[chain].proxyAdmin})`,
      signature: decoded.signature,
    };
  }

  private ismDerivationsInProgress: ChainMap<boolean> = {};

  private async deriveIsmConfig(
    chain: string,
    module: string,
  ): Promise<DerivedIsmConfig> {
    const reader = new EvmIsmReader(this.multiProvider, chain);

    // Start recording some info about the deriving
    const startTime = Date.now();
    this.logger.info(chalk.italic.gray(`Deriving ISM config for ${chain}...`));
    this.ismDerivationsInProgress[chain] = true;

    const derivedConfig = await reader.deriveIsmConfig(module);

    // Deriving is done, remove from in progress
    delete this.ismDerivationsInProgress[chain];
    this.logger.info(
      chalk.italic.blue(
        'Finished deriving ISM config',
        chain,
        'in',
        (Date.now() - startTime) / (1000 * 60),
        'mins',
      ),
    );
    const remainingInProgress = Object.keys(this.ismDerivationsInProgress);
    this.logger.info(
      chalk.italic.gray(
        'Remaining derivations in progress:',
        remainingInProgress.length,
        'chains',
        remainingInProgress,
      ),
    );

    return derivedConfig;
  }

  private async formatMailboxSetDefaultIsm(
    chain: ChainName,
    args: Record<string, any>,
  ): Promise<SetDefaultIsmInsight> {
    const { _module: module } = args;

    const derivedConfig = await this.deriveIsmConfig(chain, module);
    const expectedIsmConfig = this.coreConfig[chain].defaultIsm;

    let insight = '✅ matches expected ISM config';
    const normalizedDerived = normalizeConfig(derivedConfig);
    const normalizedExpected = normalizeConfig(expectedIsmConfig);
    if (!deepEquals(normalizedDerived, normalizedExpected)) {
      this.errors.push({
        chain: chain,
        module,
        derivedConfig,
        expectedIsmConfig,
        info: 'Incorrect default ISM being set',
      });
      insight = `❌ fatal mismatch of ISM config`;
      this.logger.error(
        chalk.bold.red(`Mismatch of ISM config for chain ${chain}!`),
      );
    }

    return {
      module,
      insight,
    };
  }

  private async readIcaRemoteCall(
    chain: ChainName,
    args: Record<string, any>,
  ): Promise<IcaRemoteCallInsight> {
    const {
      _destination: destination,
      _router: router,
      _ism: ism,
      _calls: calls,
    } = args;
    const remoteChainName = this.multiProvider.getChainName(destination);

    const expectedRouter =
      this.chainAddresses[remoteChainName].interchainAccountRouter;
    const matchesExpectedRouter =
      eqAddress(expectedRouter, bytes32ToAddress(router)) &&
      // Poor man's check that the 12 byte padding is all zeroes
      addressToBytes32(bytes32ToAddress(router)) === router;
    let routerInsight = '✅ matches expected router from artifacts';
    if (!matchesExpectedRouter) {
      this.errors.push({
        chain: chain,
        remoteDomain: destination,
        remoteChain: remoteChainName,
        router: router,
        expected: expectedRouter,
        info: 'Incorrect router in ICA call',
      });
      routerInsight = `❌ fatal mismatch, expected ${expectedRouter}`;
    }

    let ismInsight = '✅ matches expected ISM';
    if (ism !== ethers.constants.HashZero) {
      this.errors.push({
        chain: chain,
        remoteDomain: destination,
        remoteChain: remoteChainName,
        ism,
        info: 'Incorrect ISM in ICA call, expected zero hash',
      });
      ismInsight = `❌ fatal mismatch, expected zero hash`;
    }

    const remoteIcaAddress = await InterchainAccount.fromAddressesMap(
      this.chainAddresses,
      this.multiProvider,
    ).getAccount(remoteChainName, {
      owner: safes[icaOwnerChain],
      origin: icaOwnerChain,
      routerOverride: router,
      ismOverride: ism,
    });
    const expectedRemoteIcaAddress = icas[remoteChainName as keyof typeof icas];
    let remoteIcaInsight = '✅ matches expected ICA';
    if (
      !expectedRemoteIcaAddress ||
      !eqAddress(remoteIcaAddress, expectedRemoteIcaAddress)
    ) {
      this.errors.push({
        chain: chain,
        remoteDomain: destination,
        remoteChain: remoteChainName,
        ica: remoteIcaAddress,
        expected: expectedRemoteIcaAddress,
        info: 'Incorrect destination ICA in ICA call',
      });
      remoteIcaInsight = `❌ fatal mismatch, expected ${remoteIcaAddress}`;
    }

    const decodedCalls = await Promise.all(
      calls.map((call: any) => {
        const icaCallAsTx = {
          to: bytes32ToAddress(call[0]),
          value: BigNumber.from(call[1]),
          data: call[2],
        };
        return this.read(remoteChainName, icaCallAsTx);
      }),
    );

    return {
      destination: {
        domain: destination,
        chain: remoteChainName,
      },
      router: {
        address: router,
        insight: routerInsight,
      },
      ism: {
        address: ism,
        insight: ismInsight,
      },
      destinationIca: {
        address: remoteIcaAddress,
        insight: remoteIcaInsight,
      },
      calls: decodedCalls,
    };
  }

  private async readMultisendTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<MultiSendGovernTransactions> {
    if (!tx.data) {
      throw new Error('No data in multisend transaction');
    }
    const multisendDatas = decodeMultiSendData(tx.data);

    const { symbol } = await this.multiProvider.getNativeToken(chain);

    const multisends = await Promise.all(
      multisendDatas.map(async (multisend, index) => {
        const decoded = await this.read(
          chain,
          metaTransactionDataToEV5Transaction(multisend),
        );
        return {
          chain,
          index,
          value: `${ethers.utils.formatEther(multisend.value)} ${symbol}`,
          operation: formatOperationType(multisend.operation),
          decoded,
        };
      }),
    );

    return {
      chain,
      multisends,
    };
  }

  private async readOwnableTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<GovernTransaction> {
    if (!tx.data) {
      throw new Error('⚠️ No data in Ownable transaction');
    }

    const ownableInterface = Ownable__factory.createInterface();
    const decoded = ownableInterface.parseTransaction({
      data: tx.data,
      value: tx.value,
    });

    let insight;
    if (
      decoded.functionFragment.name ===
      ownableInterface.functions['renounceOwnership()'].name
    ) {
      insight = `Renounce ownership`;
    }

    if (
      decoded.functionFragment.name ===
      ownableInterface.functions['transferOwnership(address)'].name
    ) {
      const [newOwner] = decoded.args;
      insight = `Transfer ownership to ${newOwner}`;
    }

    const args = formatFunctionFragmentArgs(
      decoded.args,
      decoded.functionFragment,
    );

    return {
      chain,
      to: `Ownable (${chain} ${tx.to})`,
      ...(insight ? { insight } : { args }),
      signature: decoded.signature,
    };
  }

  isIcaTransaction(chain: ChainName, tx: AnnotatedEV5Transaction): boolean {
    return (
      tx.to !== undefined &&
      eqAddress(tx.to, this.chainAddresses[chain].interchainAccountRouter)
    );
  }

  isMailboxTransaction(chain: ChainName, tx: AnnotatedEV5Transaction): boolean {
    return (
      tx.to !== undefined &&
      eqAddress(tx.to, this.chainAddresses[chain].mailbox)
    );
  }

  isProxyAdminTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): boolean {
    return (
      tx.to !== undefined &&
      eqAddress(tx.to, this.chainAddresses[chain].proxyAdmin)
    );
  }

  async isMultisendTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<boolean> {
    if (tx.to === undefined) {
      return false;
    }
    const multiSendCallOnlyAddress = await this.getMultiSendCallOnlyAddress(
      chain,
    );
    if (!multiSendCallOnlyAddress) {
      return false;
    }

    return eqAddress(multiSendCallOnlyAddress, tx.to);
  }

  async isOwnableTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<boolean> {
    if (!tx.to) return false;
    try {
      const account = Ownable__factory.connect(
        tx.to,
        this.multiProvider.getProvider(chain),
      );
      await account.owner();
      return true;
    } catch {
      return false;
    }
  }

  private multiSendCallOnlyAddressCache: ChainMap<string> = {};

  async getMultiSendCallOnlyAddress(
    chain: ChainName,
  ): Promise<string | undefined> {
    if (this.multiSendCallOnlyAddressCache[chain]) {
      return this.multiSendCallOnlyAddressCache[chain];
    }

    const safe = safes[chain];
    if (!safe) {
      return undefined;
    }

    const { safeSdk } = await getSafeAndService(
      chain,
      this.multiProvider,
      safe,
    );

    this.multiSendCallOnlyAddressCache[chain] =
      safeSdk.getMultiSendCallOnlyAddress();
    return this.multiSendCallOnlyAddressCache[chain];
  }
}

function metaTransactionDataToEV5Transaction(
  metaTransactionData: MetaTransactionData,
): AnnotatedEV5Transaction {
  return {
    to: metaTransactionData.to,
    value: BigNumber.from(metaTransactionData.value),
    data: metaTransactionData.data,
  };
}

function formatFunctionFragmentArgs(
  args: Result,
  fragment: ethers.utils.FunctionFragment,
): Record<string, any> {
  const accumulator: Record<string, any> = {};
  return fragment.inputs.reduce((acc, input, index) => {
    acc[input.name] = args[index];
    return acc;
  }, accumulator);
}

function formatOperationType(operation: OperationType | undefined): string {
  switch (operation) {
    case OperationType.Call:
      return 'Call';
    case OperationType.DelegateCall:
      return 'Delegate Call';
    default:
      return '⚠️ Unknown ⚠️';
  }
}
