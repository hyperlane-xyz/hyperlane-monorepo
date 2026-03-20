import { Contract, constants, utils } from 'ethers';

import {
  BaseFee__factory,
  LinearFee__factory,
  RoutingFee__factory,
} from '@hyperlane-xyz/core';
import { Address, WithAddress } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName, ChainNameOrId } from '../types.js';
import { HyperlaneReader } from '../utils/HyperlaneReader.js';

import {
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

export type DerivedRoutingFeeConfig = WithAddress<RoutingFeeConfig> & {
  feeContracts: Record<ChainName, DerivedTokenFeeConfig>;
};

export type TokenFeeReaderParams = {
  address: Address;
  routingDestinations?: number[]; // Optional: when provided, derives feeContracts
  token?: Address; // Optional: required for fee contracts that don't expose token()
};

const CROSS_COLLATERAL_ROUTING_FEE_ABI = [
  'function owner() view returns (address)',
  'function feeContracts(uint32,bytes32) view returns (address)',
] as const;

export const DEFAULT_ROUTER_KEY = utils.keccak256(
  utils.toUtf8Bytes('RoutingFee.DEFAULT_ROUTER'),
);

export class EvmTokenFeeReader extends HyperlaneReader {
  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly chain: ChainNameOrId,
  ) {
    super(multiProvider, chain);
  }

  async deriveTokenFeeConfig(
    params: TokenFeeReaderParams,
  ): Promise<DerivedTokenFeeConfig> {
    const { address, routingDestinations } = params;
    const tokenFee = BaseFee__factory.connect(address, this.provider);

    let derivedConfig: DerivedTokenFeeConfig;
    let onchainFeeType: OnchainTokenFeeType;
    try {
      onchainFeeType = await tokenFee.feeType();
    } catch (feeTypeError) {
      try {
        return await this.deriveCrossCollateralRoutingFeeConfig(params);
      } catch {
        throw feeTypeError;
      }
    }
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
        });
        break;
      default:
        throw new Error(`Unsupported token fee type: ${onchainFeeType}`);
    }

    return derivedConfig;
  }

  private async deriveCrossCollateralRoutingFeeConfig(
    params: TokenFeeReaderParams,
  ): Promise<DerivedTokenFeeConfig> {
    const { address, routingDestinations, token } = params;

    const ccrf = new Contract(
      address,
      CROSS_COLLATERAL_ROUTING_FEE_ABI,
      this.provider,
    );
    // CAST: ethers Contract with human-readable ABI returns `any`; the ABI guarantees `address`
    const owner = (await ccrf.owner()) as Address;

    const feeContracts: Record<ChainName, DerivedTokenFeeConfig> = {};
    let resolvedToken: Address | undefined = token;
    if (routingDestinations) {
      await Promise.all(
        routingDestinations.map(async (destination) => {
          // CAST: ethers Contract with human-readable ABI returns `any`; the ABI guarantees `address`
          const subFeeAddress = (await ccrf.feeContracts(
            destination,
            DEFAULT_ROUTER_KEY,
          )) as Address;
          if (subFeeAddress === constants.AddressZero) return;
          const chainName = this.multiProvider.getChainName(destination);
          const subFeeConfig = await this.deriveTokenFeeConfig({
            address: subFeeAddress,
            routingDestinations,
            token: resolvedToken ?? token,
          });
          feeContracts[chainName] = subFeeConfig;
          resolvedToken ??= subFeeConfig.token;
        }),
      );
    }

    if (!resolvedToken) {
      throw new Error(
        `Unable to infer token for CrossCollateralRoutingFee at ${address}`,
      );
    }

    return {
      type: TokenFeeType.RoutingFee,
      maxFee: constants.MaxUint256.toBigInt(),
      halfAmount: constants.MaxUint256.toBigInt(),
      address,
      token: resolvedToken,
      owner,
      feeContracts,
    };
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
    const [token, owner, maxFee, halfAmount] = await Promise.all([
      routingFee.token(),
      routingFee.owner(),
      routingFee.maxFee(),
      routingFee.halfAmount(),
    ]);

    const maxFeeBn = BigInt(maxFee.toString());
    const halfAmountBn = BigInt(halfAmount.toString());

    const feeContracts: Record<ChainName, DerivedTokenFeeConfig> = {};

    if (routingDestinations)
      await Promise.all(
        routingDestinations.map(async (destination) => {
          const subFeeAddress = await routingFee.feeContracts(destination);
          if (subFeeAddress === constants.AddressZero) return;
          const chainName = this.multiProvider.getChainName(destination);
          feeContracts[chainName] = await this.deriveTokenFeeConfig({
            address: subFeeAddress,

            // Currently, it's not possible to configure nested routing fees domains,
            // but we should not expect that to exist
            routingDestinations,
          });
        }),
      );
    return {
      type: TokenFeeType.RoutingFee,
      maxFee: maxFeeBn,
      halfAmount: halfAmountBn,
      address,
      token,
      owner,
      feeContracts,
    };
  }

  private async deriveCrossCollateralRoutingFeeConfig(
    params: TokenFeeReaderParams,
  ): Promise<DerivedTokenFeeConfig> {
    const { address, routingDestinations } = params;
    if (!routingDestinations?.length) {
      throw new Error(
        'CrossCollateralRoutingFee requires routingDestinations to derive fee config',
      );
    }

    const routingFee = new Contract(
      address,
      crossCollateralRoutingFeeReadAbi,
      this.provider,
    );
    const [owner, defaultRouter] = await Promise.all([
      routingFee.owner(),
      routingFee.DEFAULT_ROUTER(),
    ]);

    const feeContracts: Record<ChainName, DerivedTokenFeeConfig> = {};
    await Promise.all(
      routingDestinations.map(async (destination) => {
        const subFeeAddress = await routingFee.feeContracts(
          destination,
          defaultRouter,
        );
        if (subFeeAddress === constants.AddressZero) return;
        const chainName = this.multiProvider.getChainName(destination);
        feeContracts[chainName] = await this.deriveTokenFeeConfig({
          address: subFeeAddress,
          routingDestinations,
        });
      }),
    );

    let token: Address | undefined;
    for (const destination of routingDestinations) {
      const chainName = this.multiProvider.getChainName(destination);
      const feeConfig = feeContracts[chainName];
      if (feeConfig) {
        token = feeConfig.token;
        break;
      }
    }
    if (!token) {
      throw new Error(
        `CrossCollateralRoutingFee at ${address} does not have any readable destination fee contracts`,
      );
    }

    return {
      type: TokenFeeType.RoutingFee,
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
