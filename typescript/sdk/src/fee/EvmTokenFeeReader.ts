import { constants } from 'ethers';

import {
  BaseFee__factory,
  CrossCollateralRoutingFee__factory,
  LinearFee__factory,
  OffchainQuotedLinearFee__factory,
  RoutingFee__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  WithAddress,
  assert,
  concurrentMap,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { DEFAULT_CONTRACT_READ_CONCURRENCY } from '../consts/concurrency.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName, ChainNameOrId } from '../types.js';
import { HyperlaneReader } from '../utils/HyperlaneReader.js';

import {
  CrossCollateralRoutingFeeConfig,
  FeeParameters,
  OnchainTokenFeeType,
  RoutingFeeConfig,
  TokenFeeConfig,
  TokenFeeType,
} from './types.js';
import {
  CrossCollateralRoutersByDomain,
  getCrossCollateralRouterKeys,
  getEffectiveCrossCollateralDestinations,
} from './crossCollateralUtils.js';
import {
  ASSUMED_MAX_AMOUNT_FOR_ZERO_SUPPLY,
  BPS_PRECISION,
  MAX_BPS,
  assertBpsPrecision,
  convertToBps,
} from './utils.js';

export type DerivedTokenFeeConfig = WithAddress<TokenFeeConfig>;
type DerivedCrossCollateralFeeContracts = Record<
  ChainName,
  Record<string, DerivedTokenFeeConfig>
>;
export type DerivedRoutingFeeConfig = WithAddress<RoutingFeeConfig> & {
  feeContracts: Record<ChainName, DerivedTokenFeeConfig>;
};
export type DerivedCrossCollateralRoutingFeeConfig =
  WithAddress<CrossCollateralRoutingFeeConfig> & {
    feeContracts: DerivedCrossCollateralFeeContracts;
  };

export type TokenFeeReaderParams = {
  address: Address;
  routingDestinations?: number[]; // Optional: when provided, derives feeContracts
  // Optional CCR-enrolled router map by destination domain (bytes32 router addresses)
  crossCollateralRouters?: CrossCollateralRoutersByDomain;
};

export class EvmTokenFeeReader extends HyperlaneReader {
  protected readonly logger = rootLogger.child({ module: 'EvmTokenFeeReader' });

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly chain: ChainNameOrId,
    protected readonly concurrency: number = multiProvider.tryGetRpcConcurrency(
      chain,
    ) ?? DEFAULT_CONTRACT_READ_CONCURRENCY,
  ) {
    super(multiProvider, chain);
  }

  async deriveTokenFeeConfig(
    params: TokenFeeReaderParams,
  ): Promise<DerivedTokenFeeConfig> {
    const { address, routingDestinations, crossCollateralRouters } = params;
    const tokenFee = BaseFee__factory.connect(address, this.provider);

    let derivedConfig: DerivedTokenFeeConfig;
    const onchainFeeType: OnchainTokenFeeType = await tokenFee.feeType();
    switch (onchainFeeType) {
      case OnchainTokenFeeType.LinearFee:
        derivedConfig = await this.deriveLinearFeeConfig(address);
        break;
      case OnchainTokenFeeType.ProgressiveFee:
        derivedConfig = await this.deriveProgressiveFeeConfig(address);
        break;
      case OnchainTokenFeeType.RegressiveFee:
        derivedConfig = await this.deriveRegressiveFeeConfig(address);
        break;
      case OnchainTokenFeeType.RoutingFee:
        derivedConfig = await this.deriveRoutingFeeConfig({
          address,
          routingDestinations,
        });
        break;
      case OnchainTokenFeeType.OffchainQuotedLinearFee:
        derivedConfig = await this.deriveOffchainQuotedLinearFeeConfig(address);
        break;
      case OnchainTokenFeeType.CrossCollateralRoutingFee:
        derivedConfig = await this.deriveCrossCollateralRoutingFeeConfig({
          address,
          routingDestinations,
          crossCollateralRouters,
        });
        break;
      default:
        throw new Error(`Unsupported token fee type: ${onchainFeeType}`);
    }

    return derivedConfig;
  }

  private async deriveLinearFeeConfig(
    address: Address,
  ): Promise<DerivedTokenFeeConfig> {
    const tokenFee = LinearFee__factory.connect(address, this.provider);
    const [token, owner, maxFee, halfAmount] = await Promise.all([
      tokenFee.token(),
      tokenFee.owner(),
      tokenFee.maxFee(),
      tokenFee.halfAmount(),
    ]);
    const maxFeeBn = BigInt(maxFee.toString());
    const halfAmountBn = BigInt(halfAmount.toString());
    const bps = convertToBps(maxFeeBn, halfAmountBn);

    return {
      type: TokenFeeType.LinearFee,
      maxFee: maxFeeBn,
      halfAmount: halfAmountBn,
      address,
      bps,
      token,
      owner,
    };
  }

  private async deriveOffchainQuotedLinearFeeConfig(
    address: Address,
  ): Promise<DerivedTokenFeeConfig> {
    const tokenFee = OffchainQuotedLinearFee__factory.connect(
      address,
      this.provider,
    );
    const [token, owner, maxFee, halfAmount, quoteSigners] = await Promise.all([
      tokenFee.token(),
      tokenFee.owner(),
      tokenFee.maxFee(),
      tokenFee.halfAmount(),
      tokenFee.quoteSigners(),
    ]);
    const maxFeeBn = BigInt(maxFee.toString());
    const halfAmountBn = BigInt(halfAmount.toString());
    const bps = convertToBps(maxFeeBn, halfAmountBn);

    return {
      type: TokenFeeType.OffchainQuotedLinearFee,
      maxFee: maxFeeBn,
      halfAmount: halfAmountBn,
      address,
      bps,
      token,
      owner,
      quoteSigners: [...quoteSigners],
    };
  }

  private async deriveProgressiveFeeConfig(
    _address: Address,
  ): Promise<DerivedTokenFeeConfig> {
    throw new Error('Not implemented');
  }

  private async deriveRegressiveFeeConfig(
    _address: Address,
  ): Promise<DerivedTokenFeeConfig> {
    throw new Error('Not implemented');
  }

  private async deriveRoutingFeeConfig(
    params: TokenFeeReaderParams,
  ): Promise<DerivedTokenFeeConfig> {
    const { address, routingDestinations } = params;
    const routingFee = RoutingFee__factory.connect(address, this.provider);
    const [token, owner] = await Promise.all([
      routingFee.token(),
      routingFee.owner(),
    ]);

    const feeContracts: Record<ChainName, DerivedTokenFeeConfig> = {};

    if (routingDestinations)
      await Promise.all(
        routingDestinations.map(async (destination) => {
          const subFeeAddress = await routingFee.feeContracts(destination);
          if (subFeeAddress === constants.AddressZero) return;
          const chainName = this.multiProvider.tryGetChainName(destination);
          if (!chainName) return;
          feeContracts[chainName] = await this.deriveTokenFeeConfig({
            address: subFeeAddress,
          });
        }),
      );
    return {
      type: TokenFeeType.RoutingFee,
      address,
      token,
      owner,
      feeContracts,
    };
  }

  private async deriveCrossCollateralRoutingFeeConfig(
    params: TokenFeeReaderParams,
  ): Promise<DerivedTokenFeeConfig> {
    const { address, routingDestinations, crossCollateralRouters } = params;
    const effectiveRoutingDestinations =
      getEffectiveCrossCollateralDestinations(
        routingDestinations,
        crossCollateralRouters,
      );

    assert(
      effectiveRoutingDestinations.length > 0,
      'CrossCollateralRoutingFee requires routingDestinations or crossCollateralRouters to derive fee config',
    );

    const routingFee = CrossCollateralRoutingFee__factory.connect(
      address,
      this.provider,
    );
    const owner = await routingFee.owner();

    const feeConfigCache = new Map<string, Promise<DerivedTokenFeeConfig>>();
    const parseFeeConfig = this.createCachedFeeConfigReader(feeConfigCache);
    const destinationEntries = await concurrentMap(
      this.concurrency,
      effectiveRoutingDestinations,
      async (destination) =>
        this.deriveCrossCollateralDestinationFees({
          routingFee,
          destination,
          crossCollateralRouters,
          parseFeeConfig,
        }),
    );

    const feeContracts: DerivedCrossCollateralFeeContracts = {};
    for (const entry of destinationEntries) {
      if (!entry) continue;
      feeContracts[entry.chainName] = entry.routerFeeConfigs;
    }

    return {
      type: TokenFeeType.CrossCollateralRoutingFee,
      address,
      owner,
      feeContracts,
    };
  }

  private createCachedFeeConfigReader(
    feeConfigCache: Map<string, Promise<DerivedTokenFeeConfig>>,
  ) {
    // Multiple router keys can point at the same child fee address.
    return async (subFeeAddress: Address): Promise<DerivedTokenFeeConfig> => {
      const cacheKey = subFeeAddress.toLowerCase();
      if (!feeConfigCache.has(cacheKey)) {
        feeConfigCache.set(
          cacheKey,
          this.deriveTokenFeeConfig({
            address: subFeeAddress,
          }),
        );
      }
      const cachedFeeConfig = feeConfigCache.get(cacheKey);
      assert(
        cachedFeeConfig,
        `Missing cached fee config promise for ${subFeeAddress}`,
      );
      return cachedFeeConfig;
    };
  }

  private async deriveCrossCollateralDestinationFees({
    routingFee,
    destination,
    crossCollateralRouters,
    parseFeeConfig,
  }: {
    routingFee: ReturnType<typeof CrossCollateralRoutingFee__factory.connect>;
    destination: number;
    crossCollateralRouters?: CrossCollateralRoutersByDomain;
    parseFeeConfig: (subFeeAddress: Address) => Promise<DerivedTokenFeeConfig>;
  }): Promise<
    | {
        chainName: ChainName;
        routerFeeConfigs: Record<string, DerivedTokenFeeConfig>;
      }
    | undefined
  > {
    const chainName = this.multiProvider.tryGetChainName(destination);
    if (!chainName) return undefined;

    const routerKeys = getCrossCollateralRouterKeys(
      destination,
      crossCollateralRouters,
    );
    const routerSubFees = await concurrentMap(
      this.concurrency,
      routerKeys,
      async (router) => ({
        router,
        subFeeAddress: await routingFee.feeContracts(destination, router),
      }),
    );

    const routerFeeConfigs: Record<string, DerivedTokenFeeConfig> = {};
    await concurrentMap(
      this.concurrency,
      routerSubFees,
      async ({ router, subFeeAddress }) => {
        if (subFeeAddress === constants.AddressZero) return;
        routerFeeConfigs[router] = await parseFeeConfig(subFeeAddress);
      },
    );

    if (Object.keys(routerFeeConfigs).length === 0) {
      return undefined;
    }

    return { chainName, routerFeeConfigs };
  }

  convertFromBps(bps: number): FeeParameters {
    if (!Number.isFinite(bps) || bps <= 0) {
      throw new Error('bps must be > 0 to prevent division by zero');
    }
    assertBpsPrecision(bps);

    const maxFee =
      BigInt(constants.MaxUint256.toString()) /
      ASSUMED_MAX_AMOUNT_FOR_ZERO_SUPPLY;
    const scaledBps = BigInt(Math.round(bps * Number(BPS_PRECISION)));
    const halfAmount = ((maxFee / 2n) * MAX_BPS * BPS_PRECISION) / scaledBps;

    return {
      maxFee,
      halfAmount,
    };
  }
}
