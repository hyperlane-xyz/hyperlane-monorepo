<<<<<<< HEAD
import { constants } from 'ethers';
=======
import { BigNumber, constants } from 'ethers';
>>>>>>> 52e2edeae (Fix fee convert functions for both bps and contract fee amounts)

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
    const [token, owner, maxFee, halfAmount] = await Promise.all([
      tokenFee.token(),
      tokenFee.owner(),
      tokenFee.maxFee(),
      tokenFee.halfAmount(),
    ]);
    const maxFeeBn = BigInt(maxFee.toString());
    const halfAmountBn = BigInt(halfAmount.toString());
    const bps = await this.convertToBps(maxFeeBn, halfAmountBn);

    return {
      token,
      owner,
      address,
      type: TokenFeeType.LinearFee,
      maxFee: maxFeeBn,
      halfAmount: halfAmountBn,
      bps,
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

<<<<<<< HEAD
  async convertFromBps(
    bps: bigint,
=======
  async convertFromBpsForLinearFee(
    bps: string,
>>>>>>> 52e2edeae (Fix fee convert functions for both bps and contract fee amounts)
    tokenAddress: Address,
  ): Promise<Pick<BaseTokenFeeConfig, 'maxFee' | 'halfAmount'>> {
    // Assume maxFee is uint256.max / token.totalSupply
    const token = ERC20__factory.connect(tokenAddress, this.provider);
<<<<<<< HEAD
    const totalSupplyBn = await token.totalSupply();
    const maxFee = BigInt(constants.MaxUint256.div(totalSupplyBn).toString());
    const halfAmount = (maxFee * 5_000n) / bps;
=======
    const totalSupply = await token.totalSupply();
    const maxFee = constants.MaxUint256.div(totalSupply);
    const halfAmount = BigNumber.from(bps).mul(
      BigNumber.from(maxFee).mul(5_000),
    );
>>>>>>> 52e2edeae (Fix fee convert functions for both bps and contract fee amounts)
    return {
      maxFee,
      halfAmount,
    };
  }

<<<<<<< HEAD
  async convertToBps(
    maxFee: bigint,
    halfAmount: bigint,
  ): Promise<BaseTokenFeeConfig['bps']> {
    const PRECISION = 10_000n;
    const bps = (maxFee * PRECISION) / (halfAmount * 2n);

    return bps;
=======
  async convertToBpsForLinearFee(
    maxFee: string,
    halfAmount: string,
  ): Promise<BaseTokenFeeConfig['bps']> {
    const maxFeeBN = BigNumber.from(maxFee);
    const halfAmountBN = BigNumber.from(halfAmount);

    const PRECISION = 10_000;
    const bps = maxFeeBN.mul(PRECISION).div(halfAmountBN.mul(2));

    return bps.toString();
>>>>>>> 52e2edeae (Fix fee convert functions for both bps and contract fee amounts)
  }
}
