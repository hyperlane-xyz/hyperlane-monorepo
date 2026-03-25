import { Contract, constants } from 'ethers';

import {
  BaseFee__factory,
  LinearFee__factory,
  RoutingFee__factory,
} from '@hyperlane-xyz/core';
import { Address, WithAddress, concurrentMap } from '@hyperlane-xyz/utils';

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
  ASSUMED_MAX_AMOUNT_FOR_ZERO_SUPPLY,
  MAX_BPS,
  convertToBps,
} from './utils.js';

export type DerivedTokenFeeConfig = WithAddress<TokenFeeConfig>;
type DerivedCrossCollateralFeeContracts = Record<
  ChainName,
  {
    default?: DerivedTokenFeeConfig;
    routers?: Record<string, DerivedTokenFeeConfig>;
  }
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
  crossCollateralRouters?: Record<number, string[]>;
};

// keccak256("RoutingFee.DEFAULT_ROUTER")
export const DEFAULT_ROUTER_KEY =
  '0x6e086cd647d6eb8b516856666e2c1465fb8a6a58d3a75938362acc674eacaf47';

const crossCollateralRoutingFeeReadAbi = [
  'function token() view returns (address)',
  'function DEFAULT_ROUTER() view returns (bytes32)',
  'function feeContracts(uint32,bytes32) view returns (address)',
  'function owner() view returns (address)',
] as const;

export class EvmTokenFeeReader extends HyperlaneReader {
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
    const onchainFeeType = (await tokenFee.feeType()) as OnchainTokenFeeType;
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
          const chainName = this.multiProvider.getChainName(destination);
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
    const { address, crossCollateralRouters } = params;
    const effectiveRoutingDestinations = Object.keys(
      crossCollateralRouters ?? {},
    ).map((domain) => Number(domain));

    if (!effectiveRoutingDestinations.length) {
      throw new Error(
        'CrossCollateralRoutingFee requires crossCollateralRouters to derive fee config',
      );
    }

    const routingFee = new Contract(
      address,
      crossCollateralRoutingFeeReadAbi,
      this.provider,
    );
    const [tokenFromContract, owner, defaultRouter] = await Promise.all([
      routingFee.token().catch(() => undefined),
      routingFee.owner(),
      routingFee.DEFAULT_ROUTER(),
    ]);

    const feeContracts: DerivedCrossCollateralFeeContracts = {};
    const feeConfigCache = new Map<string, Promise<DerivedTokenFeeConfig>>();

    const parseFeeConfig = async (subFeeAddress: Address) => {
      const cacheKey = subFeeAddress.toLowerCase();
      if (!feeConfigCache.has(cacheKey)) {
        feeConfigCache.set(
          cacheKey,
          this.deriveTokenFeeConfig({
            address: subFeeAddress,
          }),
        );
      }
      return feeConfigCache.get(cacheKey)!;
    };

    const destinationConfigs = await concurrentMap(
      this.concurrency,
      effectiveRoutingDestinations,
      async (destination) => {
        const chainName = this.multiProvider.getChainName(destination);
        const configuredRouters = crossCollateralRouters?.[destination] ?? [];
        const defaultSubFeeAddress = await routingFee.feeContracts(
          destination,
          defaultRouter,
        );
        const routerSubFees = await concurrentMap(
          this.concurrency,
          configuredRouters,
          async (router) => ({
            router,
            subFeeAddress: await routingFee.feeContracts(destination, router),
          }),
        );
        return { chainName, defaultSubFeeAddress, routerSubFees };
      },
    );

    await concurrentMap(
      this.concurrency,
      destinationConfigs,
      async (destinationConfig) => {
        const { chainName, defaultSubFeeAddress, routerSubFees } =
          destinationConfig;

        let defaultFeeConfig: DerivedTokenFeeConfig | undefined;
        if (defaultSubFeeAddress !== constants.AddressZero) {
          defaultFeeConfig = await parseFeeConfig(defaultSubFeeAddress);
        }

        const routerFeeConfigs: Record<string, DerivedTokenFeeConfig> = {};
        await concurrentMap(
          this.concurrency,
          routerSubFees,
          async ({ router, subFeeAddress }) => {
            if (subFeeAddress === constants.AddressZero) return;
            routerFeeConfigs[router] = await parseFeeConfig(subFeeAddress);
          },
        );

        if (defaultFeeConfig || Object.keys(routerFeeConfigs).length > 0) {
          feeContracts[chainName] = {
            ...(defaultFeeConfig ? { default: defaultFeeConfig } : {}),
            ...(Object.keys(routerFeeConfigs).length
              ? { routers: routerFeeConfigs }
              : {}),
          };
        }
      },
    );

    const token =
      tokenFromContract ??
      (
        await Promise.all([...feeConfigCache.values()].map((config) => config))
      )[0]?.token;
    if (!token) {
      throw new Error(
        `CrossCollateralRoutingFee at ${address} does not have any readable destination fee contracts`,
      );
    }

    return {
      type: TokenFeeType.CrossCollateralRoutingFee,
      address,
      token,
      owner,
      feeContracts,
    };
  }

  convertFromBps(bps: bigint): FeeParameters {
    if (bps === 0n) {
      throw new Error('bps must be > 0 to prevent division by zero');
    }

    const maxFee =
      BigInt(constants.MaxUint256.toString()) /
      ASSUMED_MAX_AMOUNT_FOR_ZERO_SUPPLY;
    const halfAmount = ((maxFee / 2n) * MAX_BPS) / bps;

    return {
      maxFee,
      halfAmount,
    };
  }
}
