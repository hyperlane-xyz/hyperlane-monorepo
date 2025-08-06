import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import hre from 'hardhat';

import { ERC20Test, ERC20Test__factory } from '@hyperlane-xyz/core';
import { addressToBytes32, assert } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { EvmTokenFeeDeployer } from './EvmTokenFeeDeployer.js';
import { evmTokenFeeFactories } from './contracts.js';
import { TokenFee, TokenFeeType } from './types.js';

function assertTokenConfigForTest(
  config: Partial<TokenFee>,
): asserts config is TokenFee {
  assert(config.type || !config.token || config.owner, 'Not a TokenFeeConfig');
}

const MAX_FEE = '100000000000000000000';
const HALF_AMOUNT = '50000000000000000000';
describe.only('EvmTokenFeeDeployer', () => {
  let multiProvider: MultiProvider;
  let deployer: EvmTokenFeeDeployer;
  let token: ERC20Test;
  let signer: SignerWithAddress;

  type TestCase = {
    title: string;
    config: Omit<TokenFee, 'owner' | 'token'>;
  };

  beforeEach(async () => {
    [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    deployer = new EvmTokenFeeDeployer(multiProvider, evmTokenFeeFactories);
    const factory = new ERC20Test__factory(signer);
    token = await factory.deploy('fake', 'FAKE', '100000000000000000000', 18);
    await token.deployed();
  });

  describe('basic config', () => {
    const testCases: TestCase[] = [
      {
        title: 'should deploy LinearFee with correct parameters',
        config: {
          type: TokenFeeType.LinearFee,
          maxFee: MAX_FEE,
          halfAmount: HALF_AMOUNT,
          bps: 1000,
        },
      },
      {
        title: 'should deploy ProgressiveFee with correct parameters',
        config: {
          type: TokenFeeType.ProgressiveFee,
          maxFee: MAX_FEE,
          halfAmount: HALF_AMOUNT,
          bps: 1000,
        },
      },
      {
        title: 'should deploy RegressiveFee with correct parameters',
        config: {
          type: TokenFeeType.RegressiveFee,
          maxFee: MAX_FEE,
          halfAmount: HALF_AMOUNT,
          bps: 1000,
        },
      },
    ];
    for (const testCase of testCases) {
      it.only(testCase.title, async () => {
        const config = {
          ...testCase.config,
          owner: signer.address,
          token: token.address,
        };
        assertTokenConfigForTest(config);

        const deployedContracts = await deployer.deploy({
          [TestChainName.test2]: config,
        });

        const tokenFeeContract =
          deployedContracts[TestChainName.test2][config.type];

        expect(await tokenFeeContract.owner()).to.equal(config.owner);
        expect(await tokenFeeContract.token()).to.equal(config.token);
        expect(await tokenFeeContract.maxFee()).to.equal(config.maxFee);
        expect(await tokenFeeContract.halfAmount()).to.equal(config.halfAmount);
      });
    }
  });

  it('should deploy RoutingFee with correct parameters', async () => {
    const config = {
      type: TokenFeeType.RoutingFee,
      owner: signer.address,
      token: token.address,
    };
    assertTokenConfigForTest(config);

    const deployedContracts = await deployer.deploy({
      [TestChainName.test2]: config,
    });

    const routingFeeContract =
      deployedContracts[TestChainName.test2][TokenFeeType.RoutingFee];

    expect(await routingFeeContract.owner()).to.equal(config.owner);
    expect(await routingFeeContract.token()).to.equal(config.token);

    // Deploy and set a LinearFee
    const linearFeeConfig: Extract<TokenFee, { type: TokenFeeType.LinearFee }> =
      {
        type: TokenFeeType.LinearFee,
        token: token.address,
        owner: signer.address,
        maxFee: MAX_FEE,
        halfAmount: HALF_AMOUNT,
        bps: 1000,
      };
    const linearFeeDeployer = await deployer.deploy({
      [TestChainName.test2]: linearFeeConfig,
    });

    const linearFeeContract =
      linearFeeDeployer[TestChainName.test2][TokenFeeType.LinearFee];

    await routingFeeContract.setFeeContract(1, linearFeeContract.address);

    const quote = await routingFeeContract.quoteTransferRemote(
      1,
      addressToBytes32(signer.address),
      MAX_FEE,
    );

    expect(quote.length).to.equal(1);
    expect(quote[0].amount).to.be.equal(MAX_FEE);
    expect(quote[0].token).to.equal(token.address);

    // If no fee contract is set, the quote should be zero
    const quote2 = await routingFeeContract.quoteTransferRemote(
      122222,
      addressToBytes32(signer.address),
      MAX_FEE,
    );
    expect(quote2.length).to.equal(0);
  });
});
