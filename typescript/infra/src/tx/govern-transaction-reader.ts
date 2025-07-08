import { Result } from '@ethersproject/abi';
import { decodeMultiSendData } from '@safe-global/protocol-kit/dist/src/utils/index.js';
import {
  MetaTransactionData,
  OperationType,
} from '@safe-global/safe-core-sdk-types';
import {
  getMultiSendCallOnlyDeployments,
  getMultiSendDeployments,
} from '@safe-global/safe-deployments';
import assert from 'assert';
import chalk from 'chalk';
import { BigNumber, ethers } from 'ethers';

import {
  ERC20__factory,
  HypXERC20Lockbox__factory,
  IXERC20VS__factory,
  IXERC20__factory,
  MovableCollateralRouter__factory,
  Ownable__factory,
  ProxyAdmin__factory,
  TimelockController__factory,
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
  TokenStandard,
  WarpCoreConfig,
  coreFactories,
  interchainAccountFactories,
  isProxyAdminFromBytecode,
  normalizeConfig,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  addressToBytes32,
  bytes32ToAddress,
  deepEquals,
  eqAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  getAllSafesForChain,
  getGovernanceIcas,
  getGovernanceSafes,
} from '../../config/environments/mainnet3/governance/utils.js';
import {
  icaOwnerChain,
  timelocks,
} from '../../config/environments/mainnet3/owners.js';
import {
  getEnvironmentConfig,
  getHyperlaneCore,
} from '../../scripts/core-utils.js';
import { DeployEnvironment } from '../config/environment.js';
import { tokens } from '../config/warp.js';
import { GovernanceType, determineGovernanceType } from '../governance.js';
import { getSafeTx, parseSafeTx } from '../utils/safe.js';

interface GovernTransaction extends Record<string, any> {
  chain: ChainName;
  nestedTx?: GovernTransaction;
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

type XERC20Metadata = {
  type: TokenStandard.EvmHypXERC20 | TokenStandard.EvmHypVSXERC20;
  symbol: string;
  name: string;
  decimals: number;
};

export class GovernTransactionReader {
  errors: any[] = [];

  protected readonly logger = rootLogger.child({
    module: 'GovernTransactionReader',
  });

  readonly warpRouteIndex: ChainMap<
    Record<string, WarpCoreConfig['tokens'][number]>
  > = {};

  readonly multiSendCallOnlyDeployments: Address[] = [];
  readonly multiSendDeployments: Address[] = [];
  readonly xerc20Deployments: ChainMap<Record<Address, XERC20Metadata>> = {};

  private rawWarpRouteConfigMap: Record<string, WarpCoreConfig>;

  static async create(
    environment: DeployEnvironment,
    governanceType: GovernanceType,
  ): Promise<GovernTransactionReader> {
    const config = getEnvironmentConfig(environment);
    const multiProvider = await config.getMultiProvider();
    const { chainAddresses } = await getHyperlaneCore(
      environment,
      multiProvider,
    );
    const registry = await config.getRegistry();
    const warpRoutes = await registry.getWarpRoutes();
    const safes = getGovernanceSafes(governanceType);
    const icas = getGovernanceIcas(governanceType);

    const txReaderInstance = new GovernTransactionReader(
      environment,
      multiProvider,
      chainAddresses,
      config.core,
      warpRoutes,
      safes,
      icas,
    );
    await txReaderInstance.init();
    return txReaderInstance;
  }

  constructor(
    readonly environment: DeployEnvironment,
    readonly multiProvider: MultiProvider,
    readonly chainAddresses: ChainMap<Record<string, string>>,
    readonly coreConfig: ChainMap<CoreConfig>,
    warpRoutes: Record<string, WarpCoreConfig>,
    readonly safes: ChainMap<string>,
    readonly icas: ChainMap<string>,
  ) {
    this.rawWarpRouteConfigMap = warpRoutes;
  }

  async init() {
    for (const warpRoute of Object.values(this.rawWarpRouteConfigMap)) {
      for (const token of Object.values(warpRoute.tokens)) {
        const address = token.addressOrDenom?.toLowerCase() ?? '';
        if (!this.warpRouteIndex[token.chainName]) {
          this.warpRouteIndex[token.chainName] = {};
        }
        this.warpRouteIndex[token.chainName][address] = token;

        const updateXerc20Deployments = async (
          address: string,
          type: TokenStandard.EvmHypXERC20 | TokenStandard.EvmHypVSXERC20,
        ) => {
          this.xerc20Deployments[token.chainName] ??= {};
          this.xerc20Deployments[token.chainName][address.toLowerCase()] = {
            type,
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
          };
        };

        if (
          token.standard === TokenStandard.EvmHypXERC20Lockbox ||
          token.standard === TokenStandard.EvmHypVSXERC20Lockbox
        ) {
          const provider = this.multiProvider.getProvider(token.chainName);
          const lockbox = HypXERC20Lockbox__factory.connect(
            token.addressOrDenom!,
            provider,
          );
          const xerc20 = await lockbox.xERC20();
          assert(xerc20, 'No xerc20 address');
          await updateXerc20Deployments(
            xerc20,
            token.standard === TokenStandard.EvmHypXERC20Lockbox
              ? TokenStandard.EvmHypXERC20
              : TokenStandard.EvmHypVSXERC20,
          );
        }

        if (
          token.standard == TokenStandard.EvmHypXERC20 ||
          token.standard == TokenStandard.EvmHypVSXERC20
        ) {
          assert(token.collateralAddressOrDenom, 'No collateral address');
          await updateXerc20Deployments(
            token.collateralAddressOrDenom,
            token.standard,
          );
        }
      }
    }

    // Get deployments for each version
    const versions = ['1.3.0', '1.4.1'];
    for (const version of versions) {
      const multiSendCallOnlyDeployments = getMultiSendCallOnlyDeployments({
        version,
      });
      const multiSendDeployments = getMultiSendDeployments({
        version,
      });
      assert(
        multiSendCallOnlyDeployments && multiSendDeployments,
        `MultiSend and MultiSendCallOnly deployments not found for version ${version}`,
      );

      Object.values(multiSendCallOnlyDeployments.deployments).forEach((d) => {
        this.multiSendCallOnlyDeployments.push(d.address);
      });
      Object.values(multiSendDeployments.deployments).forEach((d) => {
        this.multiSendDeployments.push(d.address);
      });
    }
  }

  async read(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<GovernTransaction> {
    // If it's to another Safe
    if (this.isSafeTransaction(chain, tx)) {
      return this.readSafeTransaction(chain, tx);
    }

    // If it's to an ICA
    if (this.isIcaTransaction(chain, tx)) {
      return this.readIcaTransaction(chain, tx);
    }

    // If it's to a Mailbox
    if (this.isMailboxTransaction(chain, tx)) {
      return this.readMailboxTransaction(chain, tx);
    }

    // If it's to a TimelockController
    if (this.isTimelockControllerTransaction(chain, tx)) {
      return this.readTimelockControllerTransaction(chain, tx);
    }

    // If it's a Multisend or MultisendCallOnly transaction
    if (await this.isMultisendTransaction(tx)) {
      return this.readMultisendTransaction(chain, tx);
    }

    // If it's a Warp Module transaction
    if (this.isWarpModuleTransaction(chain, tx)) {
      return this.readWarpModuleTransaction(chain, tx);
    }

    // If it's a Managed Lockbox transaction
    if (this.isManagedLockboxTransaction(chain, tx)) {
      return this.readManagedLockboxTransaction(chain, tx);
    }

    // If it's an XERC20 transaction
    const xerc20Type = await this.isXERC20Transaction(chain, tx);
    if (xerc20Type) {
      return this.readXERC20Transaction(chain, tx, xerc20Type);
    }

    // If it's an ERC20 transaction
    if (this.isErc20Transaction(chain, tx)) {
      return this.readErc20Transaction(chain, tx);
    }

    // If it's to a Proxy Admin
    if (await this.isProxyAdminTransaction(chain, tx)) {
      return this.readProxyAdminTransaction(chain, tx);
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

  private isErc20Transaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): boolean {
    if (!tx.to) {
      return false;
    }

    const chainTokens = tokens[chain];
    if (!chainTokens) {
      return false;
    }

    for (const address of Object.values(chainTokens)) {
      if (eqAddress(tx.to, address)) {
        return true;
      }
    }
    return false;
  }

  private async readErc20Transaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<GovernTransaction> {
    if (!tx.data) {
      throw new Error('No data in ERC20 transaction');
    }

    if (!tx.to) {
      throw new Error('No to address in ERC20 transaction');
    }

    const erc20Interface = ERC20__factory.createInterface();
    const decoded = erc20Interface.parseTransaction({
      data: tx.data,
      value: tx.value,
    });

    const erc20 = ERC20__factory.connect(
      tx.to,
      this.multiProvider.getProvider(chain),
    );

    const decimals = await erc20.decimals();
    const symbol = await erc20.symbol();

    let insight;
    switch (decoded.functionFragment.name) {
      case erc20Interface.functions['transfer(address,uint256)'].name: {
        const [to, amount] = decoded.args;
        const numTokens = ethers.utils.formatUnits(amount, decimals);
        insight = `Transfer ${numTokens} ${symbol} to ${to}`;
        break;
      }
      case erc20Interface.functions['approve(address,uint256)'].name: {
        const [spender, amount] = decoded.args;
        const numTokens = ethers.utils.formatUnits(amount, decimals);
        insight = `Approve ${numTokens} ${symbol} for ${spender}`;
        break;
      }
      case erc20Interface.functions['transferFrom(address,address,uint256)']
        .name: {
        const [from, to, amount] = decoded.args;
        const numTokens = ethers.utils.formatUnits(amount, decimals);
        insight = `Transfer ${numTokens} ${symbol} from ${from} to ${to}`;
        break;
      }
      case erc20Interface.functions['increaseAllowance(address,uint256)']
        .name: {
        const [spender, addedValue] = decoded.args;
        insight = `Increase allowance for ${spender} by ${addedValue.toString()}`;
        break;
      }
      case erc20Interface.functions['decreaseAllowance(address,uint256)']
        .name: {
        const [spender, subtractedValue] = decoded.args;
        insight = `Decrease allowance for ${spender} by ${subtractedValue.toString()}`;
        break;
      }
    }

    const args = formatFunctionFragmentArgs(
      decoded.args,
      decoded.functionFragment,
    );

    return {
      chain,
      to: `${symbol} (${chain} ${tx.to})`,
      insight,
      args,
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

  private isManagedLockboxTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): boolean {
    if (!tx.to) return false;
    const lockboxes = {
      optimism: '0x18C4CdC2d774c047Eac8375Bb09853c4D6D6dF36',
      base: '0xE92e51D99AE33114C60D9621FB2E1ec0ACeA7E30',
    };
    return (
      chain in lockboxes &&
      eqAddress(tx.to, lockboxes[chain as keyof typeof lockboxes])
    );
  }

  private readManagedLockboxTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): GovernTransaction {
    if (!tx.data) {
      throw new Error('No data in Managed Lockbox transaction');
    }

    const managedLockboxInterface = new ethers.utils.Interface([
      'function deposit(uint256 _amount) nonpayable',
      'function disableDeposits() nonpayable',
      'function enableDeposits() nonpayable',
      'function grantRole(bytes32 role, address account) nonpayable',
      'function renounceRole(bytes32 role, address callerConfirmation) nonpayable',
      'function revokeRole(bytes32 role, address account) nonpayable',
      'function withdraw(uint256 _amount) nonpayable',
      'function withdrawTo(address _to, uint256 _amount) nonpayable',
    ]);
    let decoded;
    try {
      decoded = managedLockboxInterface.parseTransaction({
        data: tx.data,
        value: tx.value,
      });
    } catch (error) {
      throw new Error('Failed to decode Managed Lockbox transaction');
    }

    const roleMap: Record<string, string> = {
      '0x0000000000000000000000000000000000000000000000000000000000000000':
        'DEFAULT_ADMIN_ROLE',
      '0xaf290d8680820aad922855f39b306097b20e28774d6c1ad35a20325630c3a02c':
        'MANAGER',
    };

    let insight;
    if (
      decoded.functionFragment.name ===
      managedLockboxInterface.functions['grantRole(bytes32,address)'].name
    ) {
      const [role, account] = decoded.args;
      const roleName = roleMap[role] ? ` ${roleMap[role]}` : '';
      insight = `Grant role${roleName} to ${account}`;
    } else {
      insight = 'Unknown function in Managed Lockbox transaction';
    }

    return {
      to: `${tx.to} (Managed Lockbox)`,
      chain,
      insight,
    };
  }

  private async isXERC20Transaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<XERC20Metadata | undefined> {
    if (!tx.to) return undefined;
    const lowerTo = tx.to.toLowerCase();
    return this.xerc20Deployments[chain]?.[lowerTo];
  }

  private async readXERC20Transaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
    metadata: XERC20Metadata,
  ): Promise<GovernTransaction> {
    if (!tx.data) {
      throw new Error('No data in XERC20 transaction');
    }

    const vsTokenInterface = IXERC20VS__factory.createInterface();
    const xerc20Interface = IXERC20__factory.createInterface();

    let decoded: ethers.utils.TransactionDescription;
    if (metadata.type === TokenStandard.EvmHypVSXERC20) {
      decoded = vsTokenInterface.parseTransaction({
        data: tx.data,
        value: tx.value,
      });
    } else {
      decoded = xerc20Interface.parseTransaction({
        data: tx.data,
        value: tx.value,
      });
    }

    let insight;
    if (metadata.type === TokenStandard.EvmHypVSXERC20) {
      switch (decoded.functionFragment.name) {
        case vsTokenInterface.functions['setBufferCap(address,uint256)'].name: {
          const [bridge, newBufferCap] = decoded.args;
          insight = `Set buffer cap for bridge ${bridge} to ${newBufferCap}`;
          break;
        }
        case vsTokenInterface.functions[
          'setRateLimitPerSecond(address,uint128)'
        ].name: {
          const [bridge, newRateLimit] = decoded.args;
          insight = `Set rate limit per second for bridge ${bridge} to ${newRateLimit}`;
          break;
        }
        case vsTokenInterface.functions['addBridge((uint112,uint128,address))']
          .name: {
          const [{ bufferCap, rateLimitPerSecond, bridge }] = decoded.args;
          insight = `Add new bridge ${bridge} with buffer cap ${bufferCap} and rate limit ${rateLimitPerSecond}`;
          break;
        }
        case vsTokenInterface.functions['removeBridge(address)'].name: {
          const [bridgeToRemove] = decoded.args;
          insight = `Remove bridge ${bridgeToRemove}`;
          break;
        }
      }
    } else {
      if (
        decoded.functionFragment.name ===
        xerc20Interface.functions['setLimits(address,uint256,uint256)'].name
      ) {
        const [bridge, mintingLimit, burningLimit] = decoded.args;
        insight = `Set limits for bridge ${bridge} - minting limit: ${mintingLimit}, burning limit: ${burningLimit}`;
      }
    }

    // general xerc20 functions
    if (!insight) {
      switch (decoded.functionFragment.name) {
        case xerc20Interface.functions['mint(address,uint256)'].name: {
          const [to, amount] = decoded.args;
          const numTokens = ethers.utils.formatUnits(amount, metadata.decimals);
          insight = `Mint ${numTokens} ${metadata.symbol} to ${to}`;
          break;
        }
        case xerc20Interface.functions['approve(address,uint256)'].name: {
          const [spender, amount] = decoded.args;
          const numTokens = ethers.utils.formatUnits(amount, metadata.decimals);
          insight = `Approve ${numTokens} ${metadata.symbol} for ${spender}`;
          break;
        }
        case xerc20Interface.functions['burn(address,uint256)'].name: {
          const [from, amount] = decoded.args;
          const numTokens = ethers.utils.formatUnits(amount, metadata.decimals);
          insight = `Burn ${numTokens} ${metadata.symbol} from ${from}`;
          break;
        }
      }
    }

    const args = formatFunctionFragmentArgs(
      decoded.args,
      decoded.functionFragment,
    );

    let ownableTx = {};
    if (!insight) {
      ownableTx = await this.readOwnableTransaction(chain, tx);
    }

    return {
      ...ownableTx,
      to: `${metadata.symbol} (${metadata.name}, ${metadata.type}, ${tx.to})`,
      chain,
      ...(insight ? { insight } : { args }),
      signature: decoded.signature,
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
    const tokenRouterInterface =
      MovableCollateralRouter__factory.createInterface();

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
      tokenRouterInterface.functions['addBridge(uint32,address)'].name
    ) {
      const [domain, bridgeAddress] = decoded.args;
      insight = `Set bridge for origin domain ${domain}to ${bridgeAddress}`;
    }

    if (
      decoded.functionFragment.name ===
      tokenRouterInterface.functions['addRebalancer(address)'].name
    ) {
      const [rebalancer] = decoded.args;
      insight = `Add rebalancer ${rebalancer}`;
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

    let insight: string | undefined;
    const args = formatFunctionFragmentArgs(
      decoded.args,
      decoded.functionFragment,
    );

    switch (decoded.functionFragment.name) {
      case proxyAdminInterface.functions['upgrade(address,address)'].name: {
        const [proxy, implementation] = decoded.args;
        insight = `Upgrade proxy ${proxy} to implementation ${implementation}`;
        break;
      }
      case proxyAdminInterface.functions[
        'upgradeAndCall(address,address,bytes)'
      ].name: {
        const [proxy, implementation, data] = decoded.args;
        insight = `Upgrade proxy ${proxy} to implementation ${implementation} with initialization data`;
        break;
      }
      case proxyAdminInterface.functions['changeProxyAdmin(address,address)']
        .name: {
        const [proxy, newAdmin] = decoded.args;
        insight = `Change admin of proxy ${proxy} to ${newAdmin}`;
        break;
      }
      case proxyAdminInterface.functions['getProxyImplementation(address)']
        .name: {
        const [proxy] = decoded.args;
        insight = `Get implementation address for proxy ${proxy}`;
        break;
      }
      case proxyAdminInterface.functions['getProxyAdmin(address)'].name: {
        const [proxy] = decoded.args;
        insight = `Get admin address for proxy ${proxy}`;
        break;
      }
      default: {
        // Fallback to ownable transaction handling for unknown functions
        const ownableTx = await this.readOwnableTransaction(chain, tx);
        return {
          ...ownableTx,
          to: `Proxy Admin (${chain} ${this.chainAddresses[chain].proxyAdmin})`,
          signature: decoded.signature,
        };
      }
    }

    return {
      chain,
      to: `Proxy Admin (${chain} ${this.chainAddresses[chain].proxyAdmin})`,
      signature: decoded.signature,
      ...(insight ? { insight } : { args }),
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
      owner: this.safes[icaOwnerChain],
      origin: icaOwnerChain,
      routerOverride: router,
      ismOverride: ism,
    });
    const expectedRemoteIcaAddress = this.icas[remoteChainName];
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
        try {
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
        } catch (error) {
          this.logger.error(
            `Failed to decode multisend at index ${index}:`,
            error,
            multisend,
          );
          throw error;
        }
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

  async isProxyAdminTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<boolean> {
    if (tx.to === undefined) {
      return false;
    }

    // Check against known proxy admin addresses first
    if (tx.to === this.chainAddresses[chain].proxyAdmin) {
      return true;
    }

    return await isProxyAdminFromBytecode(
      this.multiProvider.getProvider(chain),
      tx.to,
    );
  }

  async isMultisendTransaction(tx: AnnotatedEV5Transaction): Promise<boolean> {
    if (tx.to === undefined) {
      return false;
    }

    // Check if the transaction is to a MultiSend or MultiSendCallOnly deployment
    return (
      this.multiSendCallOnlyDeployments.some((addr) =>
        eqAddress(addr, tx.to!),
      ) || this.multiSendDeployments.some((addr) => eqAddress(addr, tx.to!))
    );
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

  private isSafeTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): boolean {
    return (
      tx.to !== undefined &&
      getAllSafesForChain(chain).some((safe) => eqAddress(tx.to!, safe))
    );
  }

  private async readSafeTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<GovernTransaction> {
    if (!tx.data) {
      throw new Error('No data in Safe transaction');
    }

    if (!tx.to) {
      throw new Error('No to address in Safe transaction');
    }

    const decoded = parseSafeTx(tx);
    const args = formatFunctionFragmentArgs(
      decoded.args,
      decoded.functionFragment,
    );

    const { governanceType } = await determineGovernanceType(chain, tx.to);
    const toInsight = `${governanceType.toUpperCase()} Safe (${chain} ${
      tx.to
    })`;

    if (decoded.functionFragment.name === 'approveHash') {
      return this.readApproveHashTransaction(
        chain,
        args,
        toInsight,
        decoded.signature,
        governanceType,
      );
    }

    return this.readGeneralSafeTransaction(chain, decoded, args, toInsight);
  }

  private async readApproveHashTransaction(
    chain: ChainName,
    args: Record<string, any>,
    toInsight: string,
    signature: string,
    governanceType: GovernanceType,
  ): Promise<GovernTransaction> {
    const approvedTx = await getSafeTx(
      chain,
      this.multiProvider,
      args.hashToApprove,
    );

    const baseResult = {
      chain,
      to: toInsight,
      insight: `Approve hash: ${args.hashToApprove}`,
      args,
      signature,
    };

    if (!approvedTx) {
      return {
        ...baseResult,
        insight: `${baseResult.insight} (transaction not found)`,
      };
    }

    const reader = await GovernTransactionReader.create(
      this.environment,
      governanceType,
    );

    const innerTx = await reader.read(chain, {
      to: approvedTx.to,
      data: approvedTx.data,
      value: BigNumber.from(approvedTx.value),
    });

    return {
      ...baseResult,
      nestedTx: innerTx,
    };
  }

  private async readGeneralSafeTransaction(
    chain: ChainName,
    decoded: {
      functionFragment: ethers.utils.FunctionFragment;
      args: Result;
      signature: string;
    },
    args: Record<string, any>,
    toInsight: string,
  ): Promise<GovernTransaction> {
    let insight;
    let innerTx;
    switch (decoded.functionFragment.name) {
      case 'execTransaction': {
        innerTx = await this.read(chain, {
          to: args.to,
          data: args.data,
          value: args.value,
        });
        insight = `Execute transaction`;
        break;
      }
      case 'execTransactionFromModule': {
        innerTx = await this.read(chain, {
          to: args.to,
          data: args.data,
          value: args.value,
        });
        insight = `Execute transaction from module`;
        break;
      }
      case 'execTransactionFromModuleReturnData': {
        innerTx = await this.read(chain, {
          to: args.to,
          data: args.data,
          value: args.value,
        });
        insight = `Execute transaction from module with return data`;
        break;
      }
      case 'addOwnerWithThreshold':
        insight = `Add owner ${args.owner} with threshold ${args._threshold}`;
        break;
      case 'removeOwner':
        insight = `Remove owner ${args.owner} with new threshold ${args._threshold}`;
        break;
      case 'swapOwner':
        insight = `Swap owner ${args.oldOwner} with ${args.newOwner}`;
        break;
      case 'changeThreshold':
        insight = `Change threshold to ${args._threshold}`;
        break;
      case 'enableModule':
        insight = `Enable module ${args.module}`;
        break;
      case 'disableModule':
        insight = `Disable module ${args.module}`;
        break;
      case 'setGuard':
        insight = `Set guard to ${args.guard}`;
        break;
      case 'setFallbackHandler':
        insight = `Set fallback handler to ${args.handler}`;
        break;
      case 'setup':
        insight = `Setup Safe with ${args._owners.length} owners, threshold ${args._threshold}, fallback handler ${args.fallbackHandler}`;
        break;
      case 'simulateAndRevert':
        insight = `Simulate and revert transaction to ${args.targetContract}`;
        break;
    }

    return {
      chain,
      to: toInsight,
      insight: insight ?? '⚠️ Unknown Safe operation',
      signature: decoded.signature,
      ...(innerTx ? { nestedTx: innerTx } : {}),
      ...(insight ? {} : { args }),
    };
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
