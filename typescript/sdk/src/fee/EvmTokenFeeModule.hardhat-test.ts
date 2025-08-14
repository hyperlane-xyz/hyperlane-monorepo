import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import hre from 'hardhat';

import { ERC20Test, ERC20Test__factory } from '@hyperlane-xyz/core';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { normalizeConfig } from '../utils/ism.js';

import { EvmTokenFeeModule } from './EvmTokenFeeModule.js';
import {
  TokenFeeConfigInput,
  TokenFeeConfigSchema,
  TokenFeeType,
} from './types.js';

const MAX_FEE = 100000000000000000000n;
const HALF_AMOUNT = 50000000000000000000n;
describe('EvmTokenFeeModule', () => {
  let multiProvider: MultiProvider;
  let signer: SignerWithAddress;
  let token: ERC20Test;
  let config: TokenFeeConfigInput;
  before(async () => {
    [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const factory = new ERC20Test__factory(signer);
    token = await factory.deploy('fake', 'FAKE', '100000000000000000000', 18);
    await token.deployed();
    config = TokenFeeConfigSchema.parse({
      type: TokenFeeType.LinearFee,
      owner: signer.address,
      token: token.address,
      maxFee: MAX_FEE,
      halfAmount: HALF_AMOUNT,
    });
  });
  it('should create a new token fee', async () => {
    const module = await EvmTokenFeeModule.create({
      multiProvider,
      chain: TestChainName.test2,
      config,
    });
    const onchainConfig = await module.read();
    expect(normalizeConfig(onchainConfig)).to.deep.equal(
      normalizeConfig({ ...config, bps: 10000n }),
    );
  });

  it('should create a new token fee with bps', async () => {
    const module = await EvmTokenFeeModule.create({
      multiProvider,
      chain: TestChainName.test2,
      config: {
        ...config,
        bps: 10000n,
      },
    });
    const onchainConfig = await module.read();
    expect(onchainConfig.bps).to.equal(10000n);
  });
});
