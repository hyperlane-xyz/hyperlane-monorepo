import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import '@nomiclabs/hardhat-waffle';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  ChainMap,
  ChainNameToDomainId,
  TestChainNames,
  TestCoreApp,
  TestCoreDeployer,
  getTestMultiProvider,
  objMap,
} from '@hyperlane-xyz/sdk';
import { utils } from '@hyperlane-xyz/utils';

import {
  HypERC20CollateralConfig,
  HypERC20Config,
  SyntheticConfig,
  TokenType,
} from '../src/config';
import { HypERC20Contracts } from '../src/contracts';
import { HypERC20Deployer } from '../src/deploy';
import {
  ERC20,
  ERC20Test__factory,
  ERC20__factory,
  HypERC20,
  HypERC20Collateral,
} from '../src/types';

const localChain = 'test1';
const remoteChain = 'test2';
const localDomain = ChainNameToDomainId[localChain];
const remoteDomain = ChainNameToDomainId[remoteChain];
const totalSupply = 3000;
const amount = 10;
const testInterchainGasPayment = 123456789;

const tokenConfig: SyntheticConfig = {
  type: TokenType.synthetic,
  name: 'HypERC20',
  symbol: 'HYP',
  totalSupply,
};

for (const withCollateral of [true, false]) {
  describe(`HypERC20${withCollateral ? 'Collateral' : ''}`, async () => {
    let owner: SignerWithAddress;
    let recipient: SignerWithAddress;
    let core: TestCoreApp;
    let deployer: HypERC20Deployer<TestChainNames>;
    let contracts: Record<TestChainNames, HypERC20Contracts>;
    let local: HypERC20 | HypERC20Collateral;
    let remote: HypERC20 | HypERC20Collateral;

    beforeEach(async () => {
      [owner, recipient] = await ethers.getSigners();
      const multiProvider = getTestMultiProvider(owner);

      const coreDeployer = new TestCoreDeployer(multiProvider);
      const coreContractsMaps = await coreDeployer.deploy();
      core = new TestCoreApp(coreContractsMaps, multiProvider);
      const coreConfig = core.getConnectionClientConfigMap();
      const configWithTokenInfo: ChainMap<
        TestChainNames,
        HypERC20Config | HypERC20CollateralConfig
      > = objMap(coreConfig, (key) => ({
        ...coreConfig[key],
        ...tokenConfig,
        owner: owner.address,
      }));

      let erc20: ERC20 | undefined;
      if (withCollateral) {
        erc20 = await new ERC20Test__factory(owner).deploy(
          tokenConfig.name,
          tokenConfig.symbol,
          tokenConfig.totalSupply,
        );
        configWithTokenInfo.test1 = {
          ...configWithTokenInfo.test1,
          type: TokenType.collateral,
          token: erc20.address,
        };
      }

      deployer = new HypERC20Deployer(multiProvider, configWithTokenInfo, core);
      contracts = await deployer.deploy();
      local = contracts[localChain].router as HypERC20;

      if (withCollateral) {
        await erc20!.approve(local.address, amount);
      }

      remote = contracts[remoteChain].router as HypERC20;
    });

    it('should not be initializable again', async () => {
      const initializeTx = withCollateral
        ? (local as HypERC20Collateral).initialize(
            ethers.constants.AddressZero,
            ethers.constants.AddressZero,
            ethers.constants.AddressZero,
          )
        : (local as HypERC20).initialize(
            ethers.constants.AddressZero,
            ethers.constants.AddressZero,
            ethers.constants.AddressZero,
            0,
            '',
            '',
          );
      await expect(initializeTx).to.be.revertedWith(
        'Initializable: contract is already initialized',
      );
    });

    it('should mint total supply to deployer', async () => {
      await expectBalance(local, recipient, 0);
      await expectBalance(local, owner, totalSupply);
      await expectBalance(remote, recipient, 0);
      await expectBalance(remote, owner, totalSupply);
    });

    // do not test underlying ERC20 collateral functionality
    if (!withCollateral) {
      it('should allow for local transfers', async () => {
        await (local as HypERC20).transfer(recipient.address, amount);
        await expectBalance(local, recipient, amount);
        await expectBalance(local, owner, totalSupply - amount);
        await expectBalance(remote, recipient, 0);
        await expectBalance(remote, owner, totalSupply);
      });
    }

    it('should allow for remote transfers', async () => {
      await local.transferRemote(
        remoteDomain,
        utils.addressToBytes32(recipient.address),
        amount,
      );

      await expectBalance(local, recipient, 0);
      await expectBalance(local, owner, totalSupply - amount);
      await expectBalance(remote, recipient, 0);
      await expectBalance(remote, owner, totalSupply);

      await core.processMessages();

      await expectBalance(local, recipient, 0);
      await expectBalance(local, owner, totalSupply - amount);
      await expectBalance(remote, recipient, amount);
      await expectBalance(remote, owner, totalSupply);
    });

    it.skip('allows interchain gas payment for remote transfers', async () => {
      const interchainGasPaymaster =
        core.contractsMap[localChain].interchainGasPaymaster.contract;
      await expect(
        local.transferRemote(
          remoteDomain,
          utils.addressToBytes32(recipient.address),
          amount,
          {
            value: testInterchainGasPayment,
          },
        ),
      ).to.emit(interchainGasPaymaster, 'GasPayment');
    });

    it('should prevent remote transfer of unowned balance', async () => {
      const revertReason = withCollateral
        ? 'ERC20: insufficient allowance'
        : 'ERC20: burn amount exceeds balance';
      await expect(
        local
          .connect(recipient)
          .transferRemote(
            remoteDomain,
            utils.addressToBytes32(recipient.address),
            amount,
          ),
      ).to.be.revertedWith(revertReason);
    });

    it('should emit TransferRemote events', async () => {
      expect(
        await local.transferRemote(
          remoteDomain,
          utils.addressToBytes32(recipient.address),
          amount,
        ),
      )
        .to.emit(local, 'SentTransferRemote')
        .withArgs(remoteDomain, recipient.address, amount);
      expect(await core.processMessages())
        .to.emit(local, 'ReceivedTransferRemote')
        .withArgs(localDomain, recipient.address, amount);
    });
  });
}

const expectBalance = async (
  token: HypERC20 | HypERC20Collateral | ERC20,
  signer: SignerWithAddress,
  balance: number,
) => {
  if (Object.keys(token.interface.functions).includes('wrappedToken()')) {
    const wrappedToken = await (token as HypERC20Collateral).wrappedToken();
    token = ERC20__factory.connect(wrappedToken, signer);
  }
  return expectTokenBalance(token as HypERC20, signer, balance);
};

const expectTokenBalance = async (
  token: ERC20,
  signer: SignerWithAddress,
  balance: number,
) => expect(await token.balanceOf(signer.address)).to.eq(balance);
