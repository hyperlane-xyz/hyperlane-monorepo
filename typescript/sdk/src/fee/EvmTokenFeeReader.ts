import { constants } from 'ethers';

import {
  BaseFee__factory,
  ERC20__factory,
  LinearFee__factory,
  RoutingFee__factory,
} from '@hyperlane-xyz/core';
import { Address, WithAddress, assert, eqAddress } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName, ChainNameOrId } from '../types.js';
import { HyperlaneReader } from '../utils/HyperlaneReader.js';

import {
  OnchainTokenFeeType,
  TokenFeeConfig,
  TokenFeeType,
  onChainTypeToTokenFeeTypeMap,
} from './types.js';

export type DerivedTokenFeeConfig = WithAddress<TokenFeeConfig>;
export class EvmTokenFeeReader extends HyperlaneReader {
  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly chain: ChainNameOrId,
  ) {
    super(multiProvider, chain);
  }

  async deriveTokenFeeConfig(
    address: Address,
    destinations?: number[],
  ): Promise<DerivedTokenFeeConfig> {
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
          destinations,
          `Destinations required for ${onChainTypeToTokenFeeTypeMap[onchainFeeType]}`,
        );
        derivedConfig = await this.deriveRoutingFeeConfig(
          address,
          destinations,
        );
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
    const bps = await EvmTokenFeeReader.convertToBps(maxFeeBn, halfAmountBn);

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
    address: Address,
    destinations: number[],
  ): Promise<DerivedTokenFeeConfig> {
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
    await Promise.all(
      destinations.map(async (destination) => {
        const subFeeAddress = await routingFee.feeContracts(destination);
        if (eqAddress(subFeeAddress, constants.AddressZero)) {
          return;
        }
        const chainName = this.multiProvider.getChainName(destination);
        feeContracts[chainName] =
          await this.deriveTokenFeeConfig(subFeeAddress);
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
  ): Promise<{ maxFee: bigint; halfAmount: bigint }> {
    // Assume maxFee is uint256.max / token.totalSupply
    const token = ERC20__factory.connect(tokenAddress, this.provider);
    const totalSupplyBn = await token.totalSupply();
    const maxFee = BigInt(constants.MaxUint256.div(totalSupplyBn).toString());

    // 5_000 because halfAmount is maxFee / 2. The total is 10_000, which is 100% in bps
    const halfAmount = (maxFee * 5_000n) / bps;
    return {
      maxFee,
      halfAmount,
    };
  }

  static convertToBps(maxFee: bigint, halfAmount: bigint): bigint {
    const PRECISION = 10_000n; // 100% in bps
    const bps = (maxFee * PRECISION) / (halfAmount * 2n);

    return bps;
  }
}
