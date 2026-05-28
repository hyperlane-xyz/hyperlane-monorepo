import {
  getMultiSendCallOnlyDeployments,
  getMultiSendDeployments,
} from '@safe-global/safe-deployments';
import assert from 'assert';
import { ethers } from 'ethers';

import {
  HypXERC20Lockbox__factory,
  Ownable__factory,
} from '@hyperlane-xyz/core';
import {
  AnnotatedEV5Transaction,
  ChainMap,
  ChainName,
  CoreConfig,
  MultiProvider,
  TokenStandard,
  WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import {
  getAllSafesForChain,
  getGovernanceIcas,
  getGovernanceSafes,
  getGovernanceTimelocks,
  getLegacyGovernanceIcas,
} from '../../config/environments/mainnet3/governance/utils.js';
import {
  getEnvironmentConfig,
  getHyperlaneCore,
} from '../../scripts/core-utils.js';
import { legacyEthIcaRouter } from '../config/chain.js';
import { DeployEnvironment } from '../config/deploy-environment.js';
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
import {
  formatFunctionFragmentArgs,
  getOwnerInsight,
} from './governance/utils.js';

export type { GovernTransaction } from './governance/types.js';

const ownableFunctionSelectors = [
  'renounceOwnership()',
  'transferOwnership(address)',
].map((func) => ethers.utils.id(func).substring(0, 10));

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

  async isOwnableTransaction(tx: AnnotatedEV5Transaction): Promise<boolean> {
    if (!tx.to || !tx.data) return false;
    return ownableFunctionSelectors.includes(tx.data.substring(0, 10));
  }
}
