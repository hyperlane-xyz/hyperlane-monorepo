import { Result } from '@ethersproject/abi';
import {
  getMultiSendCallOnlyDeployments,
  getMultiSendDeployments,
} from '@safe-global/safe-deployments';
import assert from 'assert';
import chalk from 'chalk';
import { BigNumber, ethers } from 'ethers';

import {
  BaseFee__factory,
  CrossCollateralRouter__factory,
  CrossCollateralRoutingFee__factory,
  DomainRoutingHook__factory,
  DomainRoutingIsm__factory,
  HypXERC20Lockbox__factory,
  MovableCollateralRouter__factory,
  Ownable__factory,
  RoutingFee__factory,
  TokenBridgeCctpV2__factory,
  TokenBridgeDepositAddress__factory,
  TokenBridgeOft__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import {
  AnnotatedEV5Transaction,
  ChainMap,
  ChainName,
  CoreConfig,
  DerivedIsmConfig,
  DerivedTokenFeeConfig,
  EvmIsmReader,
  EvmTokenFeeReader,
  InterchainAccount,
  MultiProvider,
  TokenFeeType,
  TokenStandard,
  WarpCoreConfig,
  coreFactories,
  OnchainTokenFeeType,
  interchainAccountFactories,
  normalizeConfig,
  onChainTypeToTokenFeeTypeMap,
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

type FeeRouteDetail = {
  type: string;
  address: string;
  bps: number;
  percent: string;
};

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
      isFeeTransaction: (chain, tx) => this.isFeeTransaction(chain, tx),
      readFeeTransaction: (chain, tx) => this.readFeeTransaction(chain, tx),
      tryReadByKnownContractInterface: (chain, tx) =>
        this.tryReadByKnownContractInterface(chain, tx),
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

  // Fee contract function selectors
  private static readonly FEE_SELECTORS = new Set([
    '0x16068373', // setFeeContract(uint32,address) - RoutingFee
    '0x1e83409a', // claim(address) - BaseFee
  ]);

  private async isFeeTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<boolean> {
    if (!tx.to || !tx.data) return false;
    const selector = tx.data.slice(0, 10).toLowerCase();
    if (!GovernTransactionReader.FEE_SELECTORS.has(selector)) return false;

    // Verify the target is actually a fee contract by checking for feeType() in bytecode
    const provider = this.multiProvider.getProvider(chain);
    const code = await provider.getCode(tx.to);
    if (code === '0x') return false;
    return code.includes('fb8dc179'); // feeType() selector
  }

  private async readFeeTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<GovernTransaction> {
    assert(tx.data, 'No data in fee transaction');
    assert(tx.to, 'No to address in fee transaction');

    const provider = this.multiProvider.getProvider(chain);
    const baseFee = BaseFee__factory.connect(tx.to, provider);

    const onChainFeeType: OnchainTokenFeeType = await baseFee.feeType();
    const feeTypeName = onChainTypeToTokenFeeTypeMap[onChainFeeType];
    assert(feeTypeName, `Unknown Fee Type ${onChainFeeType}`);

    const { insight, feeDetails, decoded } = await this.parseFeeTransactionData(
      chain,
      feeTypeName,
      tx,
    );

    const ownableTx = insight
      ? {}
      : await this.readOwnableTransaction(chain, tx);

    return {
      ...ownableTx,
      chain,
      to: `${feeTypeName} Contract (${chain} ${tx.to})`,
      ...(insight ? { insight } : {}),
      ...(feeDetails ? { feeDetails } : {}),
      signature: decoded.signature,
    };
  }

  private async parseFeeTransactionData(
    chain: ChainName,
    feeTypeName: TokenFeeType,
    tx: AnnotatedEV5Transaction,
  ): Promise<{
    decoded: ethers.utils.TransactionDescription;
    insight?: string;
    feeDetails?: Record<string, any>;
  }> {
    assert(tx.data, 'No data in fee transaction');

    // RoutingFee extends BaseFee, so its interface includes both
    // claim(address) and setFeeContract(uint32,address)
    const iface =
      feeTypeName === TokenFeeType.RoutingFee
        ? RoutingFee__factory.createInterface()
        : BaseFee__factory.createInterface();

    const decoded = iface.parseTransaction({
      data: tx.data,
      value: tx.value,
    });

    if (decoded.functionFragment.name === 'claim') {
      const [beneficiary] = decoded.args;
      return { decoded, insight: `Claim fees to ${beneficiary}` };
    }

    if (feeTypeName === TokenFeeType.RoutingFee) {
      return this.parseRoutingFeeTransaction(chain, decoded);
    }

    return { decoded };
  }

  private async parseRoutingFeeTransaction(
    chain: ChainName,
    decoded: ethers.utils.TransactionDescription,
  ): Promise<{
    decoded: ethers.utils.TransactionDescription;
    insight?: string;
    feeDetails?: Record<string, any>;
  }> {
    if (decoded.functionFragment.name !== 'setFeeContract') {
      return { decoded };
    }

    const [destination, feeContract] = decoded.args;
    const chainName =
      this.multiProvider.tryGetChainName(destination) ??
      `unknown (${destination})`;

    if (isZeroishAddress(feeContract)) {
      return {
        decoded,
        insight: `Remove fee contract for domain ${destination} (${chainName})`,
      };
    }

    try {
      const feeReader = new EvmTokenFeeReader(this.multiProvider, chain);
      const feeConfig = await feeReader.deriveTokenFeeConfig({
        address: feeContract,
      });
      const formatted = await this.formatFeeConfig(chain, feeConfig);
      return {
        decoded,
        insight: `Set fee contract for domain ${destination} (${chainName}) to ${formatted.description}`,
        feeDetails: formatted.feeDetails,
      };
    } catch (error) {
      this.logger.debug(
        `Could not read fee config for ${feeContract}: ${error}`,
      );
      return {
        decoded,
        insight: `Set fee contract for domain ${destination} (${chainName}) to ${feeContract} (Warning: could not read fee config)`,
      };
    }
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
      const feeInfo = await this.readFeeContractDetails(
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

  /**
   * Selector-based fallback for known Hyperlane contract types that may not be
   * present in the warp route registry (e.g. newly-deployed warp routes,
   * standalone routing hooks/ISMs, token bridge adapters, cross-collateral
   * routing fee contracts). Returns undefined if no interface matches.
   */
  private tryReadByKnownContractInterface(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): GovernTransaction | undefined {
    if (!tx.data || tx.data.length < 10 || !tx.to) return undefined;

    const tryParse = (iface: ethers.utils.Interface) => {
      try {
        return iface.parseTransaction({ data: tx.data!, value: tx.value });
      } catch {
        return undefined;
      }
    };

    const formatBase = (
      contractType: string,
      decoded: ethers.utils.TransactionDescription,
      insight: string,
    ) => ({
      chain,
      to: `${contractType} (${chain} ${tx.to})`,
      insight,
      signature: decoded.signature,
      decoderMatch: {
        confidence: 'selector-only',
        insight: 'unverified ABI match',
      },
    });

    // CrossCollateralRouter / MovableCollateralRouter (TokenRouter base) - newly
    // deployed warp routes not yet in the registry.
    const ccrIface = CrossCollateralRouter__factory.createInterface();
    const movableIface = MovableCollateralRouter__factory.createInterface();
    const ccrDecoded = tryParse(ccrIface) ?? tryParse(movableIface);
    if (ccrDecoded) {
      const insight = this.formatRouterCallInsight(
        ccrIface,
        movableIface,
        ccrDecoded,
      );
      return formatBase('Warp Route (unregistered)', ccrDecoded, insight);
    }

    // TokenBridgeOft adapter (LayerZero OFT bridge for warp routes).
    const oftIface = TokenBridgeOft__factory.createInterface();
    const oftDecoded = tryParse(oftIface);
    if (oftDecoded) {
      const insight = this.formatTokenBridgeOftInsight(oftIface, oftDecoded);
      return formatBase('TokenBridgeOft', oftDecoded, insight);
    }

    // TokenBridgeDepositAddress adapter (deposit-address-based bridges).
    const depositAddrIface =
      TokenBridgeDepositAddress__factory.createInterface();
    const depositAddrDecoded = tryParse(depositAddrIface);
    if (depositAddrDecoded) {
      const insight = this.formatTokenBridgeDepositAddressInsight(
        depositAddrIface,
        depositAddrDecoded,
      );
      return formatBase(
        'TokenBridgeDepositAddress',
        depositAddrDecoded,
        insight,
      );
    }

    // CrossCollateralRoutingFee - per-router fee contract routing.
    const ccrFeeIface = CrossCollateralRoutingFee__factory.createInterface();
    const ccrFeeDecoded = tryParse(ccrFeeIface);
    if (ccrFeeDecoded) {
      const insight = this.formatCrossCollateralRoutingFeeInsight(
        ccrFeeIface,
        ccrFeeDecoded,
      );
      return formatBase('CrossCollateralRoutingFee', ccrFeeDecoded, insight);
    }

    // DomainRoutingHook.setHook / setHooks
    const routingHookIface = DomainRoutingHook__factory.createInterface();
    const routingHookDecoded = tryParse(routingHookIface);
    if (routingHookDecoded) {
      const insight = this.formatDomainRoutingHookInsight(
        routingHookIface,
        routingHookDecoded,
      );
      return formatBase('DomainRoutingHook', routingHookDecoded, insight);
    }

    // DomainRoutingIsm.set / remove
    const routingIsmIface = DomainRoutingIsm__factory.createInterface();
    const routingIsmDecoded = tryParse(routingIsmIface);
    if (routingIsmDecoded) {
      const insight = this.formatDomainRoutingIsmInsight(
        routingIsmIface,
        routingIsmDecoded,
      );
      return formatBase('DomainRoutingIsm', routingIsmDecoded, insight);
    }

    return undefined;
  }

  private formatRouterCallInsight(
    ccrIface: ethers.utils.Interface,
    movableIface: ethers.utils.Interface,
    decoded: ethers.utils.TransactionDescription,
  ): string {
    const args = decoded.args;

    if (
      matchesFunctionSignature(
        decoded,
        movableIface,
        'addBridge(uint32,address)',
      )
    ) {
      return `Set bridge for origin domain ${this.formatDomain(args[0])} to ${args[1]}`;
    }
    if (
      matchesFunctionSignature(
        decoded,
        movableIface,
        'removeBridge(uint32,address)',
      )
    ) {
      return `Remove bridge ${args[1]} from domain ${this.formatDomain(args[0])}`;
    }
    if (
      matchesFunctionSignature(
        decoded,
        movableIface,
        'enrollRemoteRouter(uint32,bytes32)',
      )
    ) {
      return `Enroll remote router for domain ${this.formatDomain(args[0])} to ${args[1]}`;
    }
    if (
      matchesFunctionSignature(
        decoded,
        movableIface,
        'enrollRemoteRouters(uint32[],bytes32[])',
      )
    ) {
      const [domains, routers] = args;
      const lines = domains.map(
        (d: number, i: number) =>
          `domain ${this.formatDomain(d)} to ${routers[i]}`,
      );
      return `Enroll remote routers for ${lines.join(', ')}`;
    }
    if (
      matchesFunctionSignature(
        decoded,
        movableIface,
        'unenrollRemoteRouter(uint32)',
      )
    ) {
      return `Unenroll remote router for domain ${this.formatDomain(args[0])}`;
    }
    if (
      matchesFunctionSignature(
        decoded,
        movableIface,
        'unenrollRemoteRouters(uint32[])',
      )
    ) {
      const lines = args[0].map(
        (d: number) => `domain ${this.formatDomain(d)}`,
      );
      return `Unenroll remote routers for ${lines.join(', ')}`;
    }
    if (
      matchesFunctionSignature(
        decoded,
        movableIface,
        'setDestinationGas((uint32,uint256)[])',
      )
    ) {
      const lines = args[0].map(
        (c: { domain: number; gas: BigNumber }) =>
          `domain ${this.formatDomain(c.domain)} to ${c.gas.toString()}`,
      );
      return `Set destination gas for ${lines.join(', ')}`;
    }
    if (
      matchesFunctionSignature(
        decoded,
        movableIface,
        'setDestinationGas(uint32,uint256)',
      )
    ) {
      return `Set destination gas for domain ${this.formatDomain(args[0])} to ${args[1].toString()}`;
    }
    if (matchesFunctionSignature(decoded, movableIface, 'setHook(address)')) {
      return `Set hook to ${args[0]}`;
    }
    if (
      matchesFunctionSignature(
        decoded,
        movableIface,
        'setInterchainSecurityModule(address)',
      )
    ) {
      return `Set ISM to ${args[0]}`;
    }
    if (
      matchesFunctionSignature(
        decoded,
        movableIface,
        'setFeeRecipient(address)',
      )
    ) {
      return `Set fee recipient to ${args[0]}`;
    }
    if (
      matchesFunctionSignature(decoded, movableIface, 'addRebalancer(address)')
    ) {
      return `Add rebalancer ${args[0]}`;
    }
    if (
      matchesFunctionSignature(
        decoded,
        movableIface,
        'removeRebalancer(address)',
      )
    ) {
      return `Remove rebalancer ${args[0]}`;
    }
    if (
      matchesFunctionSignature(
        decoded,
        movableIface,
        'setRecipient(uint32,bytes32)',
      )
    ) {
      return `Set rebalance recipient for domain ${this.formatDomain(args[0])} to ${args[1]}`;
    }
    if (
      matchesFunctionSignature(decoded, movableIface, 'removeRecipient(uint32)')
    ) {
      return `Remove rebalance recipient for domain ${this.formatDomain(args[0])}`;
    }
    if (
      matchesFunctionSignature(
        decoded,
        movableIface,
        'approveTokenForBridge(address,address)',
      )
    ) {
      return `Approve token ${args[0]} for bridge ${args[1]}`;
    }
    if (
      matchesFunctionSignature(
        decoded,
        ccrIface,
        'enrollCrossCollateralRouters(uint32[],bytes32[])',
      )
    ) {
      const [domains, routers] = args;
      const lines = domains.map(
        (d: number, i: number) =>
          `domain ${this.formatDomain(d)} to ${routers[i]}`,
      );
      return `Enroll cross-collateral routers for ${lines.join(', ')}`;
    }
    if (
      matchesFunctionSignature(
        decoded,
        ccrIface,
        'unenrollCrossCollateralRouters(uint32[],bytes32[])',
      )
    ) {
      const [domains, routers] = args;
      const lines = domains.map(
        (d: number, i: number) =>
          `domain ${this.formatDomain(d)} from ${routers[i]}`,
      );
      return `Unenroll cross-collateral routers for ${lines.join(', ')}`;
    }
    return `Call ${decoded.signature}`;
  }

  private formatTokenBridgeOftInsight(
    iface: ethers.utils.Interface,
    decoded: ethers.utils.TransactionDescription,
  ): string {
    const args = decoded.args;
    if (matchesFunctionSignature(decoded, iface, 'addDomain(uint32,uint32)')) {
      return `Map Hyperlane domain ${this.formatDomain(args[0])} to LayerZero EID ${args[1]}`;
    }
    if (matchesFunctionSignature(decoded, iface, 'removeDomain(uint32)')) {
      return `Remove Hyperlane domain ${this.formatDomain(args[0])} mapping`;
    }
    if (matchesFunctionSignature(decoded, iface, 'setExtraOptions(bytes)')) {
      return `Set extra LayerZero options`;
    }
    return `Call ${decoded.signature}`;
  }

  private formatTokenBridgeDepositAddressInsight(
    iface: ethers.utils.Interface,
    decoded: ethers.utils.TransactionDescription,
  ): string {
    const args = decoded.args;
    if (
      matchesFunctionSignature(
        decoded,
        iface,
        'addDestinationConfig(uint32,address,bytes32,uint256)',
      )
    ) {
      return `Add destination config: domain ${this.formatDomain(args[0])}, depositAddress ${args[1]}, recipient ${args[2]}, feeBps ${args[3].toString()}`;
    }
    if (
      matchesFunctionSignature(
        decoded,
        iface,
        'removeDestinationConfig(uint32,bytes32)',
      )
    ) {
      return `Remove destination config: domain ${this.formatDomain(args[0])}, recipient ${args[1]}`;
    }
    return `Call ${decoded.signature}`;
  }

  private formatCrossCollateralRoutingFeeInsight(
    iface: ethers.utils.Interface,
    decoded: ethers.utils.TransactionDescription,
  ): string {
    const args = decoded.args;
    if (
      matchesFunctionSignature(
        decoded,
        iface,
        'setCrossCollateralRouterFeeContracts(uint32[],bytes32[],address[])',
      )
    ) {
      const [destinations, targetRouters, feeContracts] = args;
      const lines = destinations.map(
        (d: number, i: number) =>
          `domain ${this.formatDomain(d)} router ${targetRouters[i]} → fee ${feeContracts[i]}`,
      );
      return `Set per-router fee contracts: ${lines.join(', ')}`;
    }
    if (matchesFunctionSignature(decoded, iface, 'claim(address,address)')) {
      return `Claim ${args[1]} balance to ${args[0]}`;
    }
    return `Call ${decoded.signature}`;
  }

  private formatDomainRoutingHookInsight(
    iface: ethers.utils.Interface,
    decoded: ethers.utils.TransactionDescription,
  ): string {
    const args = decoded.args;
    if (matchesFunctionSignature(decoded, iface, 'setHook(uint32,address)')) {
      return `Set hook for destination ${this.formatDomain(args[0])} to ${args[1]}`;
    }
    if (matchesFunctionSignature(decoded, iface, 'setHook(address)')) {
      return `Set mailbox client hook to ${args[0]}`;
    }
    if (
      matchesFunctionSignature(decoded, iface, 'setHooks((uint32,address)[])')
    ) {
      const lines = args[0].map(
        (cfg: { destination: number; hook: string }) =>
          `destination ${this.formatDomain(cfg.destination)} → ${cfg.hook}`,
      );
      return `Set hooks: ${lines.join(', ')}`;
    }
    return `Call ${decoded.signature}`;
  }

  private formatDomainRoutingIsmInsight(
    iface: ethers.utils.Interface,
    decoded: ethers.utils.TransactionDescription,
  ): string {
    const args = decoded.args;
    if (matchesFunctionSignature(decoded, iface, 'set(uint32,address)')) {
      return `Set ISM for origin ${this.formatDomain(args[0])} to ${args[1]}`;
    }
    if (matchesFunctionSignature(decoded, iface, 'remove(uint32)')) {
      return `Remove ISM for origin ${this.formatDomain(args[0])}`;
    }
    return `Call ${decoded.signature}`;
  }

  /**
   * Reads fee contract details for a setFeeRecipient transaction.
   * Returns enhanced insight and feeDetails if the recipient is a fee contract.
   */
  private async readFeeContractDetails(
    chain: ChainName,
    tokenRouterAddress: Address,
    feeRecipientAddress: Address,
  ): Promise<{
    insight: string;
    description?: string;
    feeDetails?: Record<string, any>;
  }> {
    // Handle address(0) case - fee is being removed
    if (isZeroishAddress(feeRecipientAddress)) {
      return { insight: `Remove fee recipient (setting to address(0))` };
    }

    try {
      const provider = this.multiProvider.getProvider(chain);

      // Check if it's a fee contract by calling feeType()
      const baseFee = BaseFee__factory.connect(feeRecipientAddress, provider);
      const feeType = await baseFee.feeType();

      // Get routing destinations from the token router
      const tokenRouter = TokenRouter__factory.connect(
        tokenRouterAddress,
        provider,
      );
      const routerDomains = await tokenRouter.domains();

      // For RoutingFee contracts, also read domains from the fee contract itself
      // since it may have routes configured before the token router enrolls them
      let domains = routerDomains;
      if (feeType === OnchainTokenFeeType.RoutingFee) {
        const routingFee = RoutingFee__factory.connect(
          feeRecipientAddress,
          provider,
        );
        const feeDomains = await routingFee.domains();
        const domainSet = new Set([...routerDomains, ...feeDomains]);
        domains = Array.from(domainSet);
      }

      // Use EvmTokenFeeReader to derive full config
      const feeReader = new EvmTokenFeeReader(this.multiProvider, chain);
      const feeConfig = await feeReader.deriveTokenFeeConfig({
        address: feeRecipientAddress,
        routingDestinations: domains,
      });

      return await this.formatFeeConfig(chain, feeConfig);
    } catch (error) {
      // Not a fee contract or failed to read - return basic insight
      this.logger.debug(
        `Could not read fee contract details for ${feeRecipientAddress}: ${error}`,
      );
      return { insight: `Set fee recipient to ${feeRecipientAddress}` };
    }
  }

  /**
   * Formats a DerivedTokenFeeConfig into a human-readable insight and feeDetails object.
   */
  private async formatFeeConfig(
    chain: ChainName,
    feeConfig: DerivedTokenFeeConfig,
  ): Promise<{
    insight: string;
    description: string;
    feeDetails: Record<string, any>;
  }> {
    const ownerInsight = await getOwnerInsight(chain, feeConfig.owner);

    if (feeConfig.type === TokenFeeType.LinearFee) {
      // bps is in basis points (1 bps = 0.01%), convert to percentage
      const bps = feeConfig.bps ? Number(feeConfig.bps) : 0;
      const percentFormatted = (bps / 100).toFixed(2);

      const description = `LinearFee contract (${percentFormatted}% fee, owner: ${ownerInsight})`;
      return {
        insight: `Set fee recipient to ${description}`,
        description,
        feeDetails: {
          type: 'LinearFee',
          address: feeConfig.address,
          token: feeConfig.token,
          owner: feeConfig.owner,
          bps,
          percent: `${percentFormatted}%`,
        },
      };
    }

    if (feeConfig.type === TokenFeeType.RoutingFee) {
      const routes: Record<string, any> = {};
      const routeInsights: string[] = [];

      for (const [chainName, subConfig] of Object.entries(
        feeConfig.feeContracts || {},
      )) {
        const bps = subConfig.bps ? Number(subConfig.bps) : 0;
        const percent = (bps / 100).toFixed(2);

        routes[chainName] = {
          type: subConfig.type,
          address: subConfig.address,
          bps,
          percent: `${percent}%`,
        };

        if (subConfig.type === TokenFeeType.LinearFee) {
          routeInsights.push(`${chainName}: ${percent}%`);
        } else {
          routeInsights.push(`${chainName}: ${subConfig.type}`);
        }
      }

      const routeCount = Object.keys(routes).length;
      const routeSummary =
        routeCount <= 3
          ? routeInsights.join(', ')
          : `${routeCount} routes configured`;

      const description = `RoutingFee contract (${routeSummary}, owner: ${ownerInsight})`;
      return {
        insight: `Set fee recipient to ${description}`,
        description,
        feeDetails: {
          type: 'RoutingFee',
          address: feeConfig.address,
          token: feeConfig.token,
          owner: feeConfig.owner,
          routes,
        },
      };
    }

    if (feeConfig.type === TokenFeeType.CrossCollateralRoutingFee) {
      const routes: Record<string, Record<string, FeeRouteDetail>> = {};
      const routeInsights: string[] = [];

      for (const [chainName, routerConfigs] of Object.entries(
        feeConfig.feeContracts || {},
      )) {
        const routerEntries = Object.entries(routerConfigs);
        routes[chainName] = Object.fromEntries(
          routerEntries.map(([routerKey, subConfig]) => {
            const bps = subConfig.bps ? Number(subConfig.bps) : 0;
            const percent = (bps / 100).toFixed(2);

            return [
              routerKey,
              {
                type: subConfig.type,
                address: subConfig.address,
                bps,
                percent: `${percent}%`,
              },
            ];
          }),
        );

        routeInsights.push(
          `${chainName}: ${routerEntries.length} router${routerEntries.length === 1 ? '' : 's'}`,
        );
      }

      const routeCount = Object.keys(routes).length;
      const routeSummary =
        routeCount <= 3
          ? routeInsights.join(', ')
          : `${routeCount} destinations configured`;

      const description = `CrossCollateralRoutingFee contract (${routeSummary}, owner: ${ownerInsight})`;
      return {
        insight: `Set fee recipient to ${description}`,
        description,
        feeDetails: {
          type: 'CrossCollateralRoutingFee',
          address: feeConfig.address,
          owner: feeConfig.owner,
          routes,
        },
      };
    }

    // Fallback for other fee types (Progressive, Regressive)
    const description = `${feeConfig.type} contract (owner: ${ownerInsight})`;
    return {
      insight: `Set fee recipient to ${description}`,
      description,
      feeDetails: {
        type: feeConfig.type,
        address: feeConfig.address,
        token: feeConfig.token,
        owner: feeConfig.owner,
      },
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
