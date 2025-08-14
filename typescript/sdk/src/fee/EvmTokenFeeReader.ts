import { BigNumber, constants } from 'ethers';

import {
  BaseFee__factory,
  ERC20__factory,
  LinearFee__factory,
} from '@hyperlane-xyz/core';
import { Address, WithAddress } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainNameOrId } from '../types.js';
import { HyperlaneReader } from '../utils/HyperlaneReader.js';

import {
  BaseTokenFeeConfig,
  OnchainTokenFeeType,
  TokenFeeConfig,
  TokenFeeType,
} from './types.js';

type DerivedTokenFeeConfig = WithAddress<TokenFeeConfig>;
export class EvmTokenFeeReader extends HyperlaneReader {
  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly chain: ChainNameOrId,
  ) {
    super(multiProvider, chain);
  }

  async deriveTokenFeeConfig(address: Address): Promise<DerivedTokenFeeConfig> {
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
        derivedConfig = await this.deriveRoutingFeeConfig(address);
        break;
      default:
        throw new Error(
          `Unsupported token fee type: ${await tokenFee.feeType()}`,
        );
    }

    return derivedConfig;
  }

  private async deriveLinearFeeConfig(
    address: Address,
  ): Promise<DerivedTokenFeeConfig> {
    const tokenFee = LinearFee__factory.connect(address, this.provider);
    const maxFee = BigInt((await tokenFee.maxFee()).toString());
    const halfAmount = BigInt((await tokenFee.halfAmount()).toString());

    return {
      address: tokenFee.address,
      type: TokenFeeType.LinearFee,
      token: await tokenFee.token(),
      owner: await tokenFee.owner(),
      maxFee,
      halfAmount,
      bps: await this.convertToBps(maxFee, halfAmount),
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
    _address: Address,
  ): Promise<DerivedTokenFeeConfig> {
    throw new Error('Not implemented');
  }

  async convertFromBps(
    bps: bigint,
    tokenAddress: Address,
  ): Promise<Pick<BaseTokenFeeConfig, 'maxFee' | 'halfAmount'>> {
    // Assume maxFee is uint256.max / token.totalSupply
    const token = ERC20__factory.connect(tokenAddress, this.provider);
    const totalSupply = await token.totalSupply();
    const maxFee = constants.MaxUint256.div(totalSupply);
    const halfAmount = BigNumber.from(maxFee)
      .mul(5_000)
      .div(BigNumber.from(bps));
    return {
      maxFee: BigInt(maxFee.toString()),
      halfAmount: BigInt(halfAmount.toString()),
    };
  }

  async convertToBps(
    maxFee: bigint,
    halfAmount: bigint,
  ): Promise<BaseTokenFeeConfig['bps']> {
    const PRECISION = 10_000n;
    const bps = (maxFee * PRECISION) / (halfAmount * 2n);

    return bps;
  }
}
