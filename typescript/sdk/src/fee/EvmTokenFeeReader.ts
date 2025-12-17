import { constants } from 'ethers';

import {
  BaseFee__factory,
  ERC20__factory,
  LinearFee__factory,
  RoutingFee__factory,
} from '@hyperlane-xyz/core';
import { type Address, type WithAddress, assert } from '@hyperlane-xyz/utils';

import { type MultiProvider } from '../providers/MultiProvider.js';
import { type ChainName, type ChainNameOrId } from '../types.js';
import { HyperlaneReader } from '../utils/HyperlaneReader.js';

import {
  type FeeParameters,
  OnchainTokenFeeType,
  type RoutingFeeConfig,
  type TokenFeeConfig,
  TokenFeeType,
  onChainTypeToTokenFeeTypeMap,
} from './types.js';
import { MAX_BPS, convertToBps } from './utils.js';

export type DerivedTokenFeeConfig = WithAddress<TokenFeeConfig>;

export type DerivedRoutingFeeConfig = WithAddress<RoutingFeeConfig> & {
  feeContracts: Record<ChainName, DerivedTokenFeeConfig>;
};

export type TokenFeeReaderParams = {
  address: Address;
  routingDestinations?: number[]; // Required for RoutingFee.feeContracts() interface
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
    const { address, routingDestinations } = params;
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
        assert(
          routingDestinations,
          `routingDestinations required for ${onChainTypeToTokenFeeTypeMap[onchainFeeType]}`,
        );
        derivedConfig = await this.deriveRoutingFeeConfig({
          address,
          routingDestinations,
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

  async convertFromBps(
    bps: bigint,
    tokenAddress: Address,
  ): Promise<FeeParameters> {
    // Assume maxFee is uint256.max / token.totalSupply
    const token = ERC20__factory.connect(tokenAddress, this.provider);
    const totalSupplyBn = await token.totalSupply();
    const maxFee = BigInt(constants.MaxUint256.div(totalSupplyBn).toString());

    const halfAmount = ((maxFee / 2n) * MAX_BPS) / bps;
    return {
      maxFee,
      halfAmount,
    };
  }
}
