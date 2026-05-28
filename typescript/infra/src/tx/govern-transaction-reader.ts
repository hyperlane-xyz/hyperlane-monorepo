import { Result } from '@ethersproject/abi';
import {
  getMultiSendCallOnlyDeployments,
  getMultiSendDeployments,
} from '@safe-global/safe-deployments';
import assert from 'assert';
import chalk from 'chalk';
import { BigNumber, ethers } from 'ethers';

import {
  CrossCollateralRouter__factory,
  HypXERC20Lockbox__factory,
  MovableCollateralRouter__factory,
  Ownable__factory,
  TokenBridgeCctpV2__factory,
  TokenBridgeDepositAddress__factory,
  TokenBridgeOft__factory,
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
  normalizeConfig,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  StandardHookMetadataParams,
  addressToBytes32,
  bytes32ToAddress,
  deepEquals,
  eqAddress,
  isZeroishAddress,
  parseStandardHookMetadata,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { awIcasLegacy } from '../../config/environments/mainnet3/governance/ica/_awLegacy.js';
import { regularIcasLegacy } from '../../config/environments/mainnet3/governance/ica/_regularLegacy.js';
import {
  getAllSafesForChain,
  getGovernanceIcas,
  getGovernanceSafes,
  getGovernanceTimelocks,
  getLegacyGovernanceIcas,
} from '../../config/environments/mainnet3/governance/utils.js';
import { icaOwnerChain } from '../../config/environments/mainnet3/owners.js';
import {
  getEnvironmentConfig,
  getHyperlaneCore,
} from '../../scripts/core-utils.js';
import { legacyEthIcaRouter } from '../config/chain.js';
import { DeployEnvironment } from '../config/deploy-environment.js';
import { Owner, determineGovernanceType } from '../governance.js';
import { GovernanceType } from '../governanceTypes.js';
import { getSafeTx, parseSafeTx } from '../utils/safe.js';
import { buildGovernanceDecoders } from './governance/decoders/index.js';
import { readFeeContractDetails } from './governance/fees.js';
import {
  DiagnosticCollector,
  GovernTransaction,
  GovernanceDecodeDiagnostic,
  GovernanceDecoder,
  GovernanceDecoderRuntime,
  GovernanceDecoderState,
  XERC20Metadata,
} from './governance/types.js';

export type { GovernTransaction } from './governance/types.js';

interface SetDefaultIsmInsight {
  module: string;
  insight: string;
}

interface HookMetadataInsight extends StandardHookMetadataParams {
  raw: string;
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
  hookMetadata?: HookMetadataInsight;
  calls: GovernTransaction[];
}

const ownableFunctionSelectors = [
  'renounceOwnership()',
  'transferOwnership(address)',
].map((func) => ethers.utils.id(func).substring(0, 10));

// ICA router interface with hookMetadata parameter
// This overload is used by the SDK when building ICA calls with custom hook metadata
const icaInterfaceWithHookMetadata = new ethers.utils.Interface([
  'function callRemoteWithOverrides(uint32 _destination, bytes32 _router, bytes32 _ism, tuple(bytes32,uint256,bytes)[] _calls, bytes _hookMetadata) payable returns (bytes32)',
]);

// Function selector for callRemoteWithOverrides with hookMetadata (5 params)
const CALL_REMOTE_WITH_HOOK_METADATA_SELECTOR =
  icaInterfaceWithHookMetadata.getSighash('callRemoteWithOverrides');

async function parseHookMetadataWithInsight(
  chain: ChainName,
  metadata: string,
): Promise<HookMetadataInsight> {
  const parsed = parseStandardHookMetadata(metadata);
  if (!parsed) {
    return {
      raw: metadata,
      insight: '❌ failed to parse hookMetadata',
    };
  }

  const { msgValue, gasLimit, refundAddress } = parsed;

  let insight: string;
  if (isZeroishAddress(refundAddress)) {
    insight = '⚠️ refund to zero address (excess goes to msg.sender)';
  } else {
    const ownerInsight = await getOwnerInsight(chain, refundAddress);
    insight = `✅ refund to ${ownerInsight}`;
  }

  return {
    raw: metadata,
    msgValue,
    gasLimit,
    refundAddress,
    insight,
  };
}

// Patterns that may contain secrets in ethers.js RPC error messages
const SENSITIVE_PATTERNS = [
  /https?:\/\/\S+/gi, // RPC URLs (often contain API keys in path/query)
  /Bearer\s+\S+/gi,
  /(?:api_key|secret|token|key|password)=\S+/gi,
];

function sanitizeErrorMessage(msg: string): string {
  let sanitized = msg;
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized.slice(0, 120);
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as any).code;
    const prefix = typeof code === 'string' ? `[${code}] ` : '';
    return `${prefix}${sanitizeErrorMessage(error.message)}`;
  }
  return 'unknown error';
}

const RECOVERABLE_NESTED_DECODE_ERROR_CODES = new Set([
  'CALL_EXCEPTION',
  'INVALID_ARGUMENT',
  'NETWORK_ERROR',
  'SERVER_ERROR',
  'TIMEOUT',
]);

function isRecoverableNestedDecodeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const code = (error as Error & { code?: unknown }).code;
  if (
    typeof code === 'string' &&
    RECOVERABLE_NESTED_DECODE_ERROR_CODES.has(code)
  ) {
    return true;
  }

  return /no matching function|invalid sighash|data signature|no data in|failed to decode|could not decode/i.test(
    error.message,
  );
}

function matchesFunctionSignature(
  decoded: ethers.utils.TransactionDescription,
  iface: ethers.utils.Interface,
  signature: string,
): boolean {
  try {
    return decoded.sighash === iface.getSighash(signature);
  } catch {
    return false;
  }
}

export class GovernTransactionReader {
  readonly diagnostics = new DiagnosticCollector();

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
  private readonly decoders: GovernanceDecoder<unknown>[];
  private readonly decoderRuntime: GovernanceDecoderRuntime;
  private readonly decoderState: GovernanceDecoderState;

  get errors(): GovernanceDecodeDiagnostic[] {
    return this.diagnostics.fatal;
  }

  get warnings(): GovernanceDecodeDiagnostic[] {
    return this.diagnostics.warnings;
  }

  get decoderIds(): string[] {
    return this.decoders.map(({ id }) => id);
  }

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
    const legacyIcas = getLegacyGovernanceIcas(governanceType);
    const timelocks = getGovernanceTimelocks(governanceType);

    const enrichedChainAddresses = {
      ...chainAddresses,
      ethereum: {
        ...chainAddresses.ethereum,
        legacyInterchainAccountRouter: legacyEthIcaRouter,
      },
    };

    const txReaderInstance = new GovernTransactionReader(
      environment,
      multiProvider,
      enrichedChainAddresses,
      config.core,
      warpRoutes,
      safes,
      icas,
      legacyIcas,
      timelocks,
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
    readonly legacyIcas: ChainMap<string>,
    readonly timelocks: ChainMap<string>,
    decoders?: GovernanceDecoder<unknown>[],
  ) {
    this.rawWarpRouteConfigMap = warpRoutes;
    this.decoderRuntime = this.buildDecoderRuntime();
    this.decoderState = this.buildDecoderState();
    this.decoders = decoders ?? buildGovernanceDecoders();
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

      Object.values(multiSendCallOnlyDeployments.deployments).forEach(
        (d: { address: string; codeHash: string }) => {
          this.multiSendCallOnlyDeployments.push(d.address);
        },
      );
      Object.values(multiSendDeployments.deployments).forEach(
        (d: { address: string; codeHash: string }) => {
          this.multiSendDeployments.push(d.address);
        },
      );
    }
  }

  async read(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<GovernTransaction> {
    const context = {
      chain,
      tx,
      runtime: this.decoderRuntime,
      state: this.decoderState,
    };
    for (const decoder of this.decoders) {
      const match = await decoder.match(context);
      if (match !== undefined) {
        return decoder.decode({ ...context, match });
      }
    }

    return this.readUnknownTransaction(chain, tx);
  }

  private buildDecoderRuntime(): GovernanceDecoderRuntime {
    return {
      read: (chain, tx) => this.read(chain, tx),
      isOwnableTransaction: (tx) => this.isOwnableTransaction(tx),
      readOwnableTransaction: (chain, tx) =>
        this.readOwnableTransaction(chain, tx),
      isIcaTransaction: (chain, tx) => this.isIcaTransaction(chain, tx),
      readIcaTransaction: (chain, tx) => this.readIcaTransaction(chain, tx),
      isMailboxTransaction: (chain, tx) => this.isMailboxTransaction(chain, tx),
      readMailboxTransaction: (chain, tx) =>
        this.readMailboxTransaction(chain, tx),
      isWarpModuleTransaction: (chain, tx) =>
        this.isWarpModuleTransaction(chain, tx),
      readWarpModuleTransaction: (chain, tx) =>
        this.readWarpModuleTransaction(chain, tx),
    };
  }

  private buildDecoderState(): GovernanceDecoderState {
    return {
      environment: this.environment,
      multiProvider: this.multiProvider,
      chainAddresses: this.chainAddresses,
      coreConfig: this.coreConfig,
      safes: this.safes,
      icas: this.icas,
      legacyIcas: this.legacyIcas,
      timelocks: this.timelocks,
      warpRouteIndex: this.warpRouteIndex,
      multiSendCallOnlyDeployments: this.multiSendCallOnlyDeployments,
      multiSendDeployments: this.multiSendDeployments,
      xerc20Deployments: this.xerc20Deployments,
      diagnostics: this.diagnostics,
      createReader: (environment, governanceType) =>
        GovernTransactionReader.create(environment, governanceType),
    };
  }

  private readUnknownTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): GovernTransaction {
    const insight = '⚠️ Unknown transaction type';
    this.addFatalDiagnostic({
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

  private addFatalDiagnostic(
    diagnostic: Record<string, unknown> & { info: string },
  ): void {
    this.diagnostics.addFatal(diagnostic);
  }

  private addWarningDiagnostic(
    diagnostic: Record<string, unknown> & { info: string },
  ): void {
    this.diagnostics.addWarning(diagnostic);
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

  private formatDomain(domain: number | BigNumber): string {
    const domainNumber = BigNumber.isBigNumber(domain)
      ? domain.toNumber()
      : domain;
    const chainName = this.multiProvider.tryGetChainName(domainNumber);
    return chainName ? `${domainNumber} (${chainName})` : `${domainNumber}`;
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
    const ccrInterface = CrossCollateralRouter__factory.createInterface();
    const cctpV2Interface = TokenBridgeCctpV2__factory.createInterface();
    const oftInterface = TokenBridgeOft__factory.createInterface();
    const depositAddrInterface =
      TokenBridgeDepositAddress__factory.createInterface();

    // Try each interface; some registry-listed contracts are bridge adapters
    // (TokenBridgeOft, TokenBridgeDepositAddress) rather than full Routers.
    const parseAttempts: Array<() => ethers.utils.TransactionDescription> = [
      () =>
        tokenRouterInterface.parseTransaction({
          data: tx.data!,
          value: tx.value,
        }),
      () => ccrInterface.parseTransaction({ data: tx.data!, value: tx.value }),
      () =>
        cctpV2Interface.parseTransaction({ data: tx.data!, value: tx.value }),
      () => oftInterface.parseTransaction({ data: tx.data!, value: tx.value }),
      () =>
        depositAddrInterface.parseTransaction({
          data: tx.data!,
          value: tx.value,
        }),
    ];
    let decoded: ethers.utils.TransactionDescription | undefined;
    let lastError: unknown;
    for (const attempt of parseAttempts) {
      try {
        decoded = attempt();
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!decoded) {
      throw lastError;
    }

    let insight: string | undefined;
    let feeDetails: Record<string, any> | undefined;
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
      insight = `Set bridge for origin domain ${domain} to ${bridgeAddress}`;
    }

    if (
      decoded.functionFragment.name ===
      tokenRouterInterface.functions['removeBridge(uint32,address)'].name
    ) {
      const [domain, bridgeAddress] = decoded.args;
      const chainName = this.multiProvider.tryGetChainName(domain);
      insight = `Remove bridge ${bridgeAddress} from domain ${domain}${chainName ? ` (${chainName})` : ''}`;
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
      matchesFunctionSignature(
        decoded,
        tokenRouterInterface,
        'setDestinationGas((uint32,uint256)[])',
      )
    ) {
      const [gasConfigs] = decoded.args;
      const insights = gasConfigs.map(
        (config: { domain: number; gas: BigNumber }) => {
          return `domain ${this.formatDomain(config.domain)} to ${config.gas.toString()}`;
        },
      );
      insight = `Set destination gas for ${insights.join(', ')}`;
    }

    if (
      matchesFunctionSignature(
        decoded,
        tokenRouterInterface,
        'setDestinationGas(uint32,uint256)',
      )
    ) {
      const [domain, gas] = decoded.args;
      insight = `Set destination gas for domain ${this.formatDomain(
        domain,
      )} to ${gas.toString()}`;
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

    if (
      decoded.functionFragment.name ===
      tokenRouterInterface.functions['setFeeRecipient(address)'].name
    ) {
      const [recipient] = decoded.args;
      // Read fee contract details (handles address(0), non-fee contracts gracefully)
      const feeInfo = await readFeeContractDetails(
        this.multiProvider,
        chain,
        tx.to!,
        recipient,
      );
      insight = feeInfo.insight;
      feeDetails = feeInfo.feeDetails;
    }

    if (
      decoded.functionFragment.name ===
      tokenRouterInterface.functions['removeRebalancer(address)'].name
    ) {
      const [rebalancer] = decoded.args;
      insight = `Remove rebalancer ${rebalancer}`;
    }

    if (
      decoded.functionFragment.name ===
      tokenRouterInterface.functions['setRecipient(uint32,bytes32)'].name
    ) {
      const [domain, recipient] = decoded.args;
      const chainName = this.multiProvider.tryGetChainName(domain);
      insight = `Set rebalance recipient for domain ${domain}${chainName ? ` (${chainName})` : ''} to ${recipient}`;
    }

    if (
      decoded.functionFragment.name ===
      tokenRouterInterface.functions['removeRecipient(uint32)'].name
    ) {
      const [domain] = decoded.args;
      const chainName = this.multiProvider.tryGetChainName(domain);
      insight = `Remove rebalance recipient for domain ${domain}${chainName ? ` (${chainName})` : ''}`;
    }

    if (
      decoded.functionFragment.name ===
      tokenRouterInterface.functions['approveTokenForBridge(address,address)']
        .name
    ) {
      const [token, bridge] = decoded.args;
      insight = `Approve token ${token} for bridge ${bridge}`;
    }

    if (
      decoded.functionFragment.name ===
      tokenRouterInterface.functions['enrollRemoteRouter(uint32,bytes32)'].name
    ) {
      const [domain, router] = decoded.args;
      const chainName = this.multiProvider.tryGetChainName(domain);
      insight = `Enroll remote router for domain ${domain}${chainName ? ` (${chainName})` : ''} to ${router}`;
    }

    if (
      matchesFunctionSignature(
        decoded,
        cctpV2Interface,
        'setMaxFeePpm(uint256)',
      )
    ) {
      const [maxFeePpm] = decoded.args;
      const bps = BigNumber.from(maxFeePpm).toNumber() / 100;
      insight = `Set max fee to ${maxFeePpm} ppm (${bps} bps)`;
    }

    if (
      matchesFunctionSignature(
        decoded,
        ccrInterface,
        'enrollCrossCollateralRouters(uint32[],bytes32[])',
      )
    ) {
      const [domains, routers] = decoded.args;
      const insights = domains.map((domain: number, index: number) => {
        const chainName = this.multiProvider.tryGetChainName(domain);
        return `domain ${domain}${chainName ? ` (${chainName})` : ''} to ${routers[index]}`;
      });
      insight = `Enroll cross-collateral routers for ${insights.join(', ')}`;
    }

    if (
      matchesFunctionSignature(
        decoded,
        ccrInterface,
        'unenrollCrossCollateralRouters(uint32[],bytes32[])',
      )
    ) {
      const [domains, routers] = decoded.args;
      const insights = domains.map((domain: number, index: number) => {
        const chainName = this.multiProvider.tryGetChainName(domain);
        return `domain ${domain}${chainName ? ` (${chainName})` : ''} from ${routers[index]}`;
      });
      insight = `Unenroll cross-collateral routers for ${insights.join(', ')}`;
    }

    if (
      matchesFunctionSignature(
        decoded,
        oftInterface,
        'addDomain(uint32,uint32)',
      )
    ) {
      const [hypDomain, lzEid] = decoded.args;
      const chainName = this.multiProvider.tryGetChainName(hypDomain);
      insight = `Map Hyperlane domain ${hypDomain}${chainName ? ` (${chainName})` : ''} to LayerZero EID ${lzEid}`;
    }

    if (
      matchesFunctionSignature(decoded, oftInterface, 'removeDomain(uint32)')
    ) {
      const [hypDomain] = decoded.args;
      const chainName = this.multiProvider.tryGetChainName(hypDomain);
      insight = `Remove Hyperlane domain ${hypDomain}${chainName ? ` (${chainName})` : ''} mapping`;
    }

    if (
      matchesFunctionSignature(decoded, oftInterface, 'setExtraOptions(bytes)')
    ) {
      const [options] = decoded.args;
      insight = `Set LayerZero extraOptions to ${options}`;
    }

    if (
      matchesFunctionSignature(
        decoded,
        depositAddrInterface,
        'addDestinationConfig(uint32,address,bytes32,uint256)',
      )
    ) {
      const [destination, depositAddress, recipient, feeBps] = decoded.args;
      const chainName = this.multiProvider.tryGetChainName(destination);
      insight = `Add destination config: domain ${destination}${chainName ? ` (${chainName})` : ''}, depositAddress ${depositAddress}, recipient ${recipient}, feeBps ${feeBps.toString()}`;
    }

    if (
      matchesFunctionSignature(
        decoded,
        depositAddrInterface,
        'removeDestinationConfig(uint32,bytes32)',
      )
    ) {
      const [destination, recipient] = decoded.args;
      const chainName = this.multiProvider.tryGetChainName(destination);
      insight = `Remove destination config: domain ${destination}${chainName ? ` (${chainName})` : ''}, recipient ${recipient}`;
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
      ...(feeDetails && { feeDetails }),
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

    // Check selector to determine which interface to use
    const hasHookMetadata = tx.data.startsWith(
      CALL_REMOTE_WITH_HOOK_METADATA_SELECTOR,
    );
    const parseInterface = hasHookMetadata
      ? icaInterfaceWithHookMetadata
      : icaInterface;
    const decoded = parseInterface.parseTransaction({
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
      icaInterface.functions['enrollRemoteRouters(uint32[],bytes32[])'].name
    ) {
      prettyArgs = await this.formatRouterEnrollments(
        chain,
        'interchainAccountRouter',
        args,
      );
    } else if (decoded.functionFragment.name === 'callRemoteWithOverrides') {
      prettyArgs = await this.readIcaRemoteCall(chain, args);
    } else if (decoded.signature === 'transferOwnership(address)') {
      const ownableTx = await this.readOwnableTransaction(chain, tx);
      return {
        ...ownableTx,
        to: `ICA Router (${chain} ${this.chainAddresses[chain].interchainAccountRouter})`,
        signature: decoded.signature,
      };
    }

    const isLegacy = this.isLegacyEthIcaRouter(tx);
    const routerAddress = isLegacy
      ? this.chainAddresses.ethereum.legacyInterchainAccountRouter
      : this.chainAddresses[chain].interchainAccountRouter;

    return {
      to: `ICA Router${isLegacy ? ' (Legacy)' : ''} (${chain} ${routerAddress})`,
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
      const isAddressMatch = eqAddress(
        expectedRouter,
        bytes32ToAddress(routerToBeEnrolled),
      );
      const isPaddingCorrect = eqAddress(
        addressToBytes32(bytes32ToAddress(routerToBeEnrolled)),
        routerToBeEnrolled,
      );

      let insight = '✅ matches expected router from artifacts';
      if (!isAddressMatch || !isPaddingCorrect) {
        if (!isAddressMatch) {
          insight = `❌ fatal mismatch, expected ${expectedRouter}`;
          this.addFatalDiagnostic({
            chain: chain,
            remoteDomain: domain,
            remoteChain: remoteChainName,
            router: routerToBeEnrolled,
            expected: expectedRouter,
            info: 'Incorrect router address getting enrolled',
          });
        }

        if (!isPaddingCorrect) {
          // This is a subtle but important check: the address must be properly padded to 32 bytes
          insight = `❌ fatal mismatch, expected ${addressToBytes32(bytes32ToAddress(routerToBeEnrolled))}`;
          this.addFatalDiagnostic({
            chain: chain,
            remoteDomain: domain,
            remoteChain: remoteChainName,
            router: routerToBeEnrolled,
            expected: addressToBytes32(bytes32ToAddress(routerToBeEnrolled)),
            info: 'Router address is not properly padded to 32 bytes (should be 12 leading zero bytes)',
          });
        }
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
    } else if (decoded.signature === 'transferOwnership(address)') {
      // Fallback to ownable transaction handling for unknown functions
      const ownableTx = await this.readOwnableTransaction(chain, tx);
      return {
        ...ownableTx,
        to: `Mailbox (${chain} ${this.chainAddresses[chain].mailbox})`,
        signature: decoded.signature,
      };
    }

    return {
      chain,
      to: `Mailbox (${chain} ${this.chainAddresses[chain].mailbox})`,
      signature: decoded.signature,
      args: prettyArgs,
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
      this.addFatalDiagnostic({
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
      _hookMetadata: hookMetadataRaw,
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
      this.addFatalDiagnostic({
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
      this.addFatalDiagnostic({
        chain: chain,
        remoteDomain: destination,
        remoteChain: remoteChainName,
        ism,
        info: 'Incorrect ISM in ICA call, expected zero hash',
      });
      ismInsight = `❌ fatal mismatch, expected zero hash`;
    }

    const expectedRemoteIcaAddress = this.icas[remoteChainName];
    const expectedLegacyRemoteIcaAddress = this.legacyIcas[remoteChainName];
    let remoteIcaAddress: string | undefined;
    let remoteIcaInsight = '✅ matches expected ICA';

    try {
      remoteIcaAddress = await InterchainAccount.fromAddressesMap(
        this.chainAddresses,
        this.multiProvider,
      ).getAccount(remoteChainName, {
        owner: this.safes[icaOwnerChain],
        origin: icaOwnerChain,
        routerOverride: router,
        ismOverride: ism,
      });

      if (!expectedRemoteIcaAddress && !expectedLegacyRemoteIcaAddress) {
        remoteIcaInsight = `⚠️ no expected ICA configured for ${remoteChainName}, derived: ${remoteIcaAddress}`;
      } else {
        const isValidIca =
          expectedRemoteIcaAddress &&
          eqAddress(remoteIcaAddress, expectedRemoteIcaAddress);
        const isValidLegacyIca =
          expectedLegacyRemoteIcaAddress &&
          eqAddress(remoteIcaAddress, expectedLegacyRemoteIcaAddress);

        if (!isValidIca && !isValidLegacyIca) {
          const displayExpected =
            expectedRemoteIcaAddress ??
            expectedLegacyRemoteIcaAddress ??
            '<none>';
          this.addFatalDiagnostic({
            chain: chain,
            remoteDomain: destination,
            remoteChain: remoteChainName,
            ica: remoteIcaAddress,
            expected: displayExpected,
            info: 'Incorrect destination ICA in ICA call',
          });
          remoteIcaInsight = `❌ fatal mismatch, expected ${displayExpected}`;
        }
      }
    } catch (error: unknown) {
      this.logger.warn(
        `Failed to derive ICA address for ${remoteChainName}, using expected address: ${summarizeError(error)}`,
      );
      this.addWarningDiagnostic({
        chain,
        remoteDomain: destination,
        remoteChain: remoteChainName,
        info: 'Could not verify destination ICA address',
        error: summarizeError(error),
      });
      remoteIcaAddress =
        expectedRemoteIcaAddress ?? expectedLegacyRemoteIcaAddress;
      remoteIcaInsight = `⚠️ could not verify ICA on ${remoteChainName} (${summarizeError(error)})`;
    }

    const decodedCalls = await Promise.all(
      calls.map(async (call: any) => {
        const icaCallAsTx = {
          to: bytes32ToAddress(call[0]),
          value: BigNumber.from(call[1]),
          data: call[2],
        };
        try {
          return await this.read(remoteChainName, icaCallAsTx);
        } catch (error: unknown) {
          if (!isRecoverableNestedDecodeError(error)) {
            throw error;
          }
          this.logger.warn(
            `Failed to decode ICA call to ${icaCallAsTx.to} on ${remoteChainName}: ${summarizeError(error)}`,
          );
          this.addWarningDiagnostic({
            chain,
            remoteDomain: destination,
            remoteChain: remoteChainName,
            to: icaCallAsTx.to,
            info: 'Could not decode nested ICA call',
            error: summarizeError(error),
          });
          return {
            chain: remoteChainName,
            insight: `⚠️ failed to decode (${summarizeError(error)})`,
            to: icaCallAsTx.to,
            data: call[2],
          };
        }
      }),
    );

    const hookMetadataInsight = hookMetadataRaw
      ? await parseHookMetadataWithInsight(chain, hookMetadataRaw)
      : undefined;

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
        address: remoteIcaAddress ?? 'unknown',
        insight: remoteIcaInsight,
      },
      ...(hookMetadataInsight && { hookMetadata: hookMetadataInsight }),
      calls: decodedCalls,
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
      const newOwnerInsight = await getOwnerInsight(chain, newOwner);
      insight = `Transfer ownership to ${newOwnerInsight}`;
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
    if (tx.to === undefined) return false;

    const isCurrentRouter = eqAddress(
      tx.to,
      this.chainAddresses[chain].interchainAccountRouter,
    );
    // Check for legacy ETH ICA router (used for legacy ICA chains like arcadia)
    const isLegacyEthRouter = eqAddress(
      tx.to,
      this.chainAddresses.ethereum.legacyInterchainAccountRouter,
    );

    return isCurrentRouter || isLegacyEthRouter;
  }

  isLegacyEthIcaRouter(tx: AnnotatedEV5Transaction): boolean {
    return (
      tx.to !== undefined &&
      eqAddress(
        tx.to,
        this.chainAddresses.ethereum.legacyInterchainAccountRouter,
      )
    );
  }

  isMailboxTransaction(chain: ChainName, tx: AnnotatedEV5Transaction): boolean {
    return (
      tx.to !== undefined &&
      eqAddress(tx.to, this.chainAddresses[chain].mailbox)
    );
  }

  async isOwnableTransaction(tx: AnnotatedEV5Transaction): Promise<boolean> {
    if (!tx.to || !tx.data) return false;
    return ownableFunctionSelectors.includes(tx.data.substring(0, 10));
  }
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

async function getOwnerInsight(
  chain: ChainName,
  address: Address,
): Promise<string> {
  const { ownerType, governanceType } = await determineGovernanceType(
    chain,
    address,
  );
  if (ownerType !== Owner.UNKNOWN) {
    return `${address} (${governanceType.toUpperCase()} ${ownerType})`;
  }

  if (awIcasLegacy[chain] && eqAddress(address, awIcasLegacy[chain])) {
    return `${address} (${GovernanceType.AbacusWorks.toUpperCase()} ${Owner.ICA} LEGACY)`;
  }

  if (
    regularIcasLegacy[chain] &&
    eqAddress(address, regularIcasLegacy[chain])
  ) {
    return `${address} (${GovernanceType.Regular.toUpperCase()} ${Owner.ICA} LEGACY)`;
  }

  return `${address} (Unknown)`;
}
