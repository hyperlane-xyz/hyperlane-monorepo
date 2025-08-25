import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { assert, expect } from 'chai';
import hre from 'hardhat';

import { ERC20Test, ERC20Test__factory } from '@hyperlane-xyz/core';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { normalizeConfig } from '../utils/ism.js';

import { EvmTokenFeeModule } from './EvmTokenFeeModule.js';
import { EvmTokenFeeReader } from './EvmTokenFeeReader.js';
import { TokenFeeConfig, TokenFeeType } from './types.js';

const MAX_FEE = 1157920892373161954235709850086879078532699846656405640394n;
const HALF_AMOUNT = 578960446186580977117854925043439539266349923328202820197n;
const BPS = EvmTokenFeeReader.convertToBps(MAX_FEE, HALF_AMOUNT);
describe('EvmTokenFeeModule', () => {
  let multiProvider: MultiProvider;
  let signer: SignerWithAddress;
  let token: ERC20Test;
  let config: TokenFeeConfig;
  before(async () => {
    [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const factory = new ERC20Test__factory(signer);
    token = await factory.deploy('fake', 'FAKE', '100000000000000000000', 18);
    await token.deployed();

    config = {
      type: TokenFeeType.LinearFee,
      owner: signer.address,
      token: token.address,
      maxFee: MAX_FEE,
      halfAmount: HALF_AMOUNT,
      bps: BPS,
    };
  });
  it('should create a new token fee', async () => {
    const module = await EvmTokenFeeModule.create({
      multiProvider,
      chain: TestChainName.test2,
      config,
    });
    const onchainConfig = await module.read();
    expect(normalizeConfig(onchainConfig)).to.deep.equal(
      normalizeConfig({ ...config, maxFee: MAX_FEE, halfAmount: HALF_AMOUNT }),
    );
  });

  it('should create a new token fee with bps', async () => {
    const module = await EvmTokenFeeModule.create({
      multiProvider,
      chain: TestChainName.test2,
      config,
    });
    const onchainConfig = await module.read();
    assert(
      onchainConfig.type === TokenFeeType.LinearFee,
      `Must be ${TokenFeeType.LinearFee}`,
    );
    expect(onchainConfig.bps).to.equal(BPS);
  });
});
