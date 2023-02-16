import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import '@nomiclabs/hardhat-waffle';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { BigNumberish } from 'ethers';
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
  HypERC20Config,
  SyntheticConfig,
  TokenConfig,
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
  HypNative,
} from '../src/types';

const localChain = 'test1';
const remoteChain = 'test2';
const localDomain = ChainNameToDomainId[localChain];
const remoteDomain = ChainNameToDomainId[remoteChain];
const totalSupply = 3000;
const amount = 10;

const tokenConfig: SyntheticConfig = {
  type: TokenType.synthetic,
  name: 'HypERC20',
  symbol: 'HYP',
  totalSupply,
};

for (const variant of [
  TokenType.synthetic,
  TokenType.collateral,
  TokenType.native,
]) {
  describe(`HypERC20${variant}`, async () => {
    let owner: SignerWithAddress;
    let recipient: SignerWithAddress;
    let core: TestCoreApp;
    let deployer: HypERC20Deployer<TestChainNames>;
    let contracts: Record<TestChainNames, HypERC20Contracts>;
    let localTokenConfig: TokenConfig = tokenConfig;
    let local: HypERC20 | HypERC20Collateral | HypNative;
    let remote: HypERC20 | HypERC20Collateral;
    let gas: BigNumber;

    beforeEach(async () => {
      [owner, recipient] = await ethers.getSigners();
      const multiProvider = getTestMultiProvider(owner);

      const coreDeployer = new TestCoreDeployer(multiProvider);
      const coreContractsMaps = await coreDeployer.deploy();
      core = new TestCoreApp(coreContractsMaps, multiProvider);
      const coreConfig = core.getConnectionClientConfigMap();

      let erc20: ERC20 | undefined;
      if (variant === TokenType.collateral) {
        erc20 = await new ERC20Test__factory(owner).deploy(
          tokenConfig.name,
          tokenConfig.symbol,
          tokenConfig.totalSupply,
        );
        localTokenConfig = {
          type: variant,
          token: erc20.address,
        };
      } else if (variant === TokenType.native) {
        localTokenConfig = {
          type: variant,
        };
      }

      const config: ChainMap<TestChainNames, HypERC20Config> = objMap(
        coreConfig,
        (key) => ({
          ...coreConfig[key],
          ...(key === localChain ? localTokenConfig : tokenConfig),
          owner: owner.address,
        }),
      );

      deployer = new HypERC20Deployer(multiProvider, config, core);
      contracts = await deployer.deploy();
      local = contracts[localChain].router as HypERC20;

      gas = await local.quoteGasPayment(remoteDomain);

      if (variant === TokenType.native) {
        gas = gas.add(amount);
      }

      if (variant === TokenType.collateral) {
        await erc20!.approve(local.address, amount);
      }

      remote = contracts[remoteChain].router as HypERC20;
    });

    it('should not be initializable again', async () => {
      const initializeTx =
        variant === TokenType.collateral || variant === TokenType.native
          ? (local as HypERC20Collateral).initialize(
              ethers.constants.AddressZero,
              ethers.constants.AddressZero,
            )
          : (local as HypERC20).initialize(
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

    if (variant === TokenType.synthetic) {
      it('should mint total supply to deployer', async () => {
        await expectBalance(local, recipient, 0);
        await expectBalance(local, owner, totalSupply);
        await expectBalance(remote, recipient, 0);
        await expectBalance(remote, owner, totalSupply);
      });

      it('should allow for local transfers', async () => {
        await (local as HypERC20).transfer(recipient.address, amount);
        await expectBalance(local, recipient, amount);
        await expectBalance(local, owner, totalSupply - amount);
        await expectBalance(remote, recipient, 0);
        await expectBalance(remote, owner, totalSupply);
      });
    }

    it('benchmark handle gas overhead', async () => {
      const localRaw = local.connect(ethers.provider);
      const mailboxAddress =
        core.contractsMap[localChain].mailbox.contract.address;
      if (variant === TokenType.collateral) {
        const tokenAddress = await (local as HypERC20Collateral).wrappedToken();
        const token = ERC20__factory.connect(tokenAddress, owner);
        await token.transfer(local.address, totalSupply);
      } else if (variant === TokenType.native) {
        const remoteDomain = ChainNameToDomainId[remoteChain];
        // deposit amount
        await local.transferRemote(
          remoteDomain,
          utils.addressToBytes32(remote.address),
          amount,
          { value: gas },
        );
      }
      const message = `${utils.addressToBytes32(
        recipient.address,
      )}${BigNumber.from(amount).toHexString().slice(2).padStart(64, '0')}`;
      const handleGas = await localRaw.estimateGas.handle(
        remoteDomain,
        utils.addressToBytes32(remote.address),
        message,
        { from: mailboxAddress },
      );
      console.log(handleGas);
    });

    it('should allow for remote transfers', async () => {
      const localOwner = await local.balanceOf(owner.address);
      const localRecipient = await local.balanceOf(recipient.address);
      const remoteOwner = await remote.balanceOf(owner.address);
      const remoteRecipient = await remote.balanceOf(recipient.address);

      await local.transferRemote(
        remoteDomain,
        utils.addressToBytes32(recipient.address),
        amount,
        {
          value: gas,
        },
      );

      let expectedLocal = localOwner.sub(amount);

      await expectBalance(local, recipient, localRecipient);
      if (variant === TokenType.native) {
        // account for tx fees, rewards, etc.
        expectedLocal = await local.balanceOf(owner.address);
      }
      await expectBalance(local, owner, expectedLocal);
      await expectBalance(remote, recipient, remoteRecipient);
      await expectBalance(remote, owner, remoteOwner);

      await core.processMessages();

      await expectBalance(local, recipient, localRecipient);
      if (variant === TokenType.native) {
        // account for tx fees, rewards, etc.
        expectedLocal = await local.balanceOf(owner.address);
      }
      await expectBalance(local, owner, expectedLocal);
      await expectBalance(remote, recipient, remoteRecipient.add(amount));
      await expectBalance(remote, owner, remoteOwner);
    });

    it('allows interchain gas payment for remote transfers', async () => {
      const interchainGasPaymaster =
        core.contractsMap[localChain].interchainGasPaymaster.contract;

      await expect(
        local.transferRemote(
          remoteDomain,
          utils.addressToBytes32(recipient.address),
          amount,
          { value: gas },
        ),
      ).to.emit(interchainGasPaymaster, 'GasPayment');
    });

    it('should prevent remote transfer of unowned balance', async () => {
      const revertReason = (): string => {
        switch (variant) {
          case TokenType.synthetic:
            return 'ERC20: burn amount exceeds balance';
          case TokenType.collateral:
            return 'ERC20: insufficient allowance';
          case TokenType.native:
            return 'Native: amount exceeds msg.value';
        }
        return '';
      };
      const value = variant === TokenType.native ? amount - 1 : gas;
      await expect(
        local
          .connect(recipient)
          .transferRemote(
            remoteDomain,
            utils.addressToBytes32(recipient.address),
            amount,
            { value },
          ),
      ).to.be.revertedWith(revertReason());
    });

    it('should emit TransferRemote events', async () => {
      expect(
        await local.transferRemote(
          remoteDomain,
          utils.addressToBytes32(recipient.address),
          amount,
          { value: gas },
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
  token: HypERC20 | HypERC20Collateral | ERC20 | HypNative,
  signer: SignerWithAddress,
  balance: BigNumberish,
) => {
  return expect(await token.balanceOf(signer.address)).to.eq(balance);
};
