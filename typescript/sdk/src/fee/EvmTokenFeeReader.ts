import { constants } from 'ethers';

import {
  BaseFee__factory,
  LinearFee__factory,
  RoutingFee__factory,
} from '@hyperlane-xyz/core';
import { Address, WithAddress, addressToBytes32 } from '@hyperlane-xyz/utils';

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
  routerFeeContracts?: Record<ChainName, Record<string, DerivedTokenFeeConfig>>;
};

export type TokenFeeReaderParams = {
  address: Address;
  routingDestinations?: number[]; // Optional: when provided, derives feeContracts
  routersByDestination?: Record<number, string[]>; // Optional: destination domain -> router addresses, derives routerFeeContracts
};

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
    const { address, routingDestinations, routersByDestination } = params;
    const tokenFee = BaseFee__factory.connect(address, this.provider);

    let derivedConfig: DerivedTokenFeeConfig;
    const onchainFeeType = await tokenFee.feeType();
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
          routersByDestination,
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
    const { address, routingDestinations, routersByDestination } = params;
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
          const subFeeAddress = await routingFee.feeContracts(
            destination,
            constants.HashZero,
          );
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

    const routerFeeContracts: Record<
      ChainName,
      Record<string, DerivedTokenFeeConfig>
    > = {};
    if (routersByDestination) {
      await Promise.all(
        Object.entries(routersByDestination).map(
          async ([destStr, routerAddrs]) => {
            const destination = Number(destStr);
            const chainName = this.multiProvider.getChainName(destination);
            const perRouter: Record<string, DerivedTokenFeeConfig> = {};
            await Promise.all(
              routerAddrs.map(async (routerAddr) => {
                const routerBytes32 = addressToBytes32(routerAddr);
                const subFeeAddress = await routingFee.feeContracts(
                  destination,
                  routerBytes32,
                );
                if (subFeeAddress === constants.AddressZero) return;
                perRouter[routerBytes32] = await this.deriveTokenFeeConfig({
                  address: subFeeAddress,
                });
              }),
            );
            if (Object.keys(perRouter).length > 0) {
              routerFeeContracts[chainName] = perRouter;
            }
          },
        ),
      );
    }

    return {
      type: TokenFeeType.RoutingFee,
      maxFee: maxFeeBn,
      halfAmount: halfAmountBn,
      address,
      token,
      owner,
      feeContracts,
      ...(Object.keys(routerFeeContracts).length > 0 && {
        routerFeeContracts,
      }),
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
