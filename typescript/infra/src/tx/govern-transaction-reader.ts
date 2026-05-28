import { Result } from '@ethersproject/abi';
import {
  getMultiSendCallOnlyDeployments,
  getMultiSendDeployments,
} from '@safe-global/safe-deployments';
import assert from 'assert';
import { BigNumber, ethers } from 'ethers';

import {
  HypXERC20Lockbox__factory,
  Ownable__factory,
} from '@hyperlane-xyz/core';
import {
  AnnotatedEV5Transaction,
  ChainMap,
  ChainName,
  CoreConfig,
  InterchainAccount,
  MultiProvider,
  TokenStandard,
  WarpCoreConfig,
  interchainAccountFactories,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  StandardHookMetadataParams,
  addressToBytes32,
  bytes32ToAddress,
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
