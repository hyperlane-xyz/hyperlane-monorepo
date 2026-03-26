import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  ERC20Test,
  ERC20Test__factory,
  LinearFee__factory,
  ProgressiveFee__factory,
} from '@hyperlane-xyz/core';
import { addressToBytes32, randomInt } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { EvmTokenFeeDeployer } from './EvmTokenFeeDeployer.js';
import { BPS, HALF_AMOUNT, MAX_FEE } from './EvmTokenFeeReader.hardhat-test.js';
import {
  DEFAULT_ROUTER_KEY,
  LinearFeeConfig,
  ProgressiveFeeConfig,
  RegressiveFeeConfig,
  CrossCollateralRoutingFeeConfigSchema,
  RoutingFeeConfigSchema,
  TokenFeeConfigSchema,
  TokenFeeType,
} from './types.js';
import { convertToBps } from './utils.js';

type DistributiveOmit<T, K extends keyof T> = T extends any
  ? Omit<T, K>
  : never;
describe('EvmTokenFeeDeployer', () => {
  let multiProvider: MultiProvider;
  let deployer: EvmTokenFeeDeployer;
  let token: ERC20Test;
  let signer: SignerWithAddress;

  type TestCase = {
    title: string;
    config: DistributiveOmit<
      LinearFeeConfig | ProgressiveFeeConfig | RegressiveFeeConfig,
      'owner' | 'token' // Omit owner and token because they are created after the beforeEach
    >;
  };

  beforeEach(async () => {
    [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    deployer = new EvmTokenFeeDeployer(multiProvider, TestChainName.test2);
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
          bps: BPS,
        },
      },
      {
        title: 'should deploy ProgressiveFee with correct parameters',
        config: {
          type: TokenFeeType.ProgressiveFee,
          maxFee: MAX_FEE,
          halfAmount: HALF_AMOUNT,
        },
      },
      {
        title: 'should deploy RegressiveFee with correct parameters',
        config: {
          type: TokenFeeType.RegressiveFee,
          maxFee: MAX_FEE,
          halfAmount: HALF_AMOUNT,
        },
      },
    ];
    for (const testCase of testCases) {
      it(testCase.title, async () => {
        const config = {
          ...testCase.config,
          owner: signer.address,
          token: token.address,
        };

        const deployedContracts = await deployer.deploy({
          [TestChainName.test2]: TokenFeeConfigSchema.parse(config),
        });

        const tokenFeeContract =
          deployedContracts[TestChainName.test2][config.type];

        expect(await tokenFeeContract.owner()).to.equal(config.owner);
        expect(await tokenFeeContract.token()).to.equal(config.token);

        if (config.type === TokenFeeType.LinearFee)
          expect(
            convertToBps(
              (await tokenFeeContract.maxFee()).toBigInt(),
              (await tokenFeeContract.halfAmount()).toBigInt(),
            ),
          ).to.equal(config.bps);
      });
    }
  });

  it('should deploy RoutingFee with correct parameters', async () => {
    const config = TokenFeeConfigSchema.parse({
      type: TokenFeeType.RoutingFee,
      owner: signer.address,
      token: token.address,
      feeContracts: {},
    });

    const deployedContracts = await deployer.deploy({
      [TestChainName.test2]: config,
    });

    const routingFeeContract =
      deployedContracts[TestChainName.test2][TokenFeeType.RoutingFee];

    expect(await routingFeeContract.owner()).to.equal(config.owner);
    expect(await routingFeeContract.token()).to.equal(config.token);

    // Deploy and set a LinearFee
    const linearFeeConfig = {
      type: TokenFeeType.LinearFee,
      token: token.address,
      owner: signer.address,
      maxFee: MAX_FEE,
      halfAmount: HALF_AMOUNT,
      bps: BPS,
    };
    const parsedConfig = TokenFeeConfigSchema.parse(linearFeeConfig);
    const linearFeeDeployer = await deployer.deploy({
      [TestChainName.test2]: parsedConfig,
    });

    const linearFeeContract =
      linearFeeDeployer[TestChainName.test2][TokenFeeType.LinearFee];

    await routingFeeContract.setFeeContract(1, linearFeeContract.address);

    const amount = randomInt(1, 10000000000000);
    const quote = await routingFeeContract[
      'quoteTransferRemote(uint32,bytes32,uint256)'
    ](1, addressToBytes32(signer.address), amount);

    expect(quote.length).to.equal(1);
    expect(quote[0].amount).to.be.equal((BigInt(amount) * BPS) / 10_000n);
    expect(quote[0].token).to.equal(token.address);

    // If no fee contract is set, the quote should be zero
    const quote2 = await routingFeeContract[
      'quoteTransferRemote(uint32,bytes32,uint256)'
    ](122222, addressToBytes32(signer.address), MAX_FEE);
    expect(quote2.length).to.equal(0);
  });

  it('should deploy RoutingFee with multiple fee contracts', async () => {
    const config = RoutingFeeConfigSchema.parse({
      type: TokenFeeType.RoutingFee,
      owner: signer.address,
      token: token.address,
      feeContracts: {
        [TestChainName.test2]: {
          type: TokenFeeType.LinearFee,
          token: token.address,
          owner: signer.address,
          maxFee: MAX_FEE,
          halfAmount: HALF_AMOUNT,
          bps: BPS,
        },
      },
    });

    const deployedContracts = await deployer.deploy({
      [TestChainName.test2]: config,
    });

    const routingFeeContract =
      deployedContracts[TestChainName.test2][TokenFeeType.RoutingFee];

    expect(await routingFeeContract.owner()).to.equal(config.owner);
    expect(await routingFeeContract.token()).to.equal(config.token);

    // Read the actual address of the deployed routing fee contract
    const actualLinearFeeAddress = await routingFeeContract.feeContracts(
      multiProvider.getDomainId(TestChainName.test2),
    );
    const linearFeeContract = LinearFee__factory.connect(
      actualLinearFeeAddress,
      signer,
    );

    expect(actualLinearFeeAddress).to.not.equal(
      hre.ethers.constants.AddressZero,
    );
    expect(await linearFeeContract.owner()).to.equal(config.owner);
    expect(await linearFeeContract.token()).to.equal(config.token);
  });

  it('should deploy RoutingFee with fee contracts when owner differs from signer', async () => {
    const [, otherSigner] = await hre.ethers.getSigners();

    const config = RoutingFeeConfigSchema.parse({
      type: TokenFeeType.RoutingFee,
      owner: otherSigner.address,
      token: token.address,
      feeContracts: {
        [TestChainName.test2]: {
          type: TokenFeeType.LinearFee,
          token: token.address,
          owner: otherSigner.address,
          maxFee: MAX_FEE,
          halfAmount: HALF_AMOUNT,
          bps: BPS,
        },
      },
    });

    const deployedContracts = await deployer.deploy({
      [TestChainName.test2]: config,
    });

    const routingFeeContract =
      deployedContracts[TestChainName.test2][TokenFeeType.RoutingFee];

    expect(await routingFeeContract.owner()).to.equal(config.owner);

    const actualLinearFeeAddress = await routingFeeContract.feeContracts(
      multiProvider.getDomainId(TestChainName.test2),
    );
    const linearFeeContract = LinearFee__factory.connect(
      actualLinearFeeAddress,
      signer,
    );
    expect(actualLinearFeeAddress).to.not.equal(
      hre.ethers.constants.AddressZero,
    );
    expect(await linearFeeContract.owner()).to.equal(otherSigner.address);
  });

  it('should deploy RoutingFee and transfer ownership when owner differs from signer (no fee contracts)', async () => {
    const [, otherSigner] = await hre.ethers.getSigners();

    const config = TokenFeeConfigSchema.parse({
      type: TokenFeeType.RoutingFee,
      owner: otherSigner.address,
      token: token.address,
      feeContracts: {},
    });

    const deployedContracts = await deployer.deploy({
      [TestChainName.test2]: config,
    });

    const routingFeeContract =
      deployedContracts[TestChainName.test2][TokenFeeType.RoutingFee];

    expect(await routingFeeContract.owner()).to.equal(otherSigner.address);
    expect(await routingFeeContract.token()).to.equal(token.address);
  });

  it('should deploy CrossCollateralRoutingFee with router-keyed fee contracts', async () => {
    const routerKey = hre.ethers.utils.hexZeroPad(signer.address, 32);
    const config = CrossCollateralRoutingFeeConfigSchema.parse({
      type: TokenFeeType.CrossCollateralRoutingFee,
      owner: signer.address,
      token: token.address,
      feeContracts: {
        [TestChainName.test2]: {
          [DEFAULT_ROUTER_KEY]: {
            type: TokenFeeType.LinearFee,
            token: token.address,
            owner: signer.address,
            maxFee: MAX_FEE,
            halfAmount: HALF_AMOUNT,
            bps: BPS,
          },
          [routerKey]: {
            type: TokenFeeType.ProgressiveFee,
            token: token.address,
            owner: signer.address,
            maxFee: MAX_FEE,
            halfAmount: HALF_AMOUNT,
          },
        },
      },
    });

    const deployedContracts = await deployer.deploy({
      [TestChainName.test2]: config,
    });

    const routingFeeContract =
      deployedContracts[TestChainName.test2][
        TokenFeeType.CrossCollateralRoutingFee
      ];
    const defaultRouter = await routingFeeContract.DEFAULT_ROUTER();
    const destinationDomain = multiProvider.getDomainId(TestChainName.test2);
    const defaultFeeAddress = await routingFeeContract.feeContracts(
      destinationDomain,
      defaultRouter,
    );
    const routerFeeAddress = await routingFeeContract.feeContracts(
      destinationDomain,
      routerKey,
    );
    const defaultFeeContract = LinearFee__factory.connect(
      defaultFeeAddress,
      signer,
    );
    const routerFeeContract = ProgressiveFee__factory.connect(
      routerFeeAddress,
      signer,
    );

    expect(defaultFeeAddress).to.not.equal(hre.ethers.constants.AddressZero);
    expect(routerFeeAddress).to.not.equal(hre.ethers.constants.AddressZero);
    expect(await defaultFeeContract.owner()).to.equal(config.owner);
    expect(await defaultFeeContract.token()).to.equal(config.token);
    expect(await routerFeeContract.owner()).to.equal(config.owner);
    expect(await routerFeeContract.token()).to.equal(config.token);
  });
});
