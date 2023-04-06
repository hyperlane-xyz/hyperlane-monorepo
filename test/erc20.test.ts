import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import '@nomiclabs/hardhat-waffle';
import { expect } from 'chai';
import { BigNumber, BigNumberish } from 'ethers';
import { ethers } from 'hardhat';

import { InterchainGasPaymaster__factory } from '@hyperlane-xyz/core';
import {
  ChainMap,
  Chains,
  HyperlaneContractsMap,
  MultiProvider,
  RouterConfig,
  TestCoreApp,
  TestCoreDeployer,
  deployTestIgpsAndGetRouterConfig,
  objMap,
} from '@hyperlane-xyz/sdk';
import { utils } from '@hyperlane-xyz/utils';

import { TokenConfig, TokenType } from '../src/config';
import { HypERC20Factories } from '../src/contracts';
import { HypERC20Deployer } from '../src/deploy';
import {
  ERC20,
  ERC20Test__factory,
  ERC20__factory,
  HypERC20,
  HypERC20Collateral,
  HypNative,
} from '../src/types';

const localChain = Chains.test1;
const remoteChain = Chains.test2;
let localDomain: number;
let remoteDomain: number;
const totalSupply = 3000;
const amount = 10;

const tokenMetadata = {
  name: 'HypERC20',
  symbol: 'HYP',
  decimals: 18,
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
    let deployer: HypERC20Deployer;
    let contracts: HyperlaneContractsMap<HypERC20Factories>;
    let localTokenConfig: TokenConfig;
    let local: HypERC20 | HypERC20Collateral | HypNative;
    let remote: HypERC20;
    let interchainGasPayment: BigNumber;

    beforeEach(async () => {
      [owner, recipient] = await ethers.getSigners();
      const multiProvider = MultiProvider.createTestMultiProvider({
        signer: owner,
      });
      localDomain = multiProvider.getDomainId(localChain);
      remoteDomain = multiProvider.getDomainId(remoteChain);

      const coreDeployer = new TestCoreDeployer(multiProvider);
      const coreContractsMaps = await coreDeployer.deploy();
      core = new TestCoreApp(coreContractsMaps, multiProvider);
      const routerConfig = await deployTestIgpsAndGetRouterConfig(
        multiProvider,
        owner.address,
        core.contractsMap,
      );

      let erc20: ERC20 | undefined;
      if (variant === TokenType.collateral) {
        erc20 = await new ERC20Test__factory(owner).deploy(
          tokenMetadata.name,
          tokenMetadata.symbol,
          tokenMetadata.totalSupply,
        );
        localTokenConfig = {
          type: variant,
          token: erc20.address,
        };
      } else if (variant === TokenType.native) {
        localTokenConfig = {
          type: variant,
        };
      } else if (variant === TokenType.synthetic) {
        localTokenConfig = { type: variant, ...tokenMetadata };
      }

      const config = objMap(routerConfig, (key) => ({
        ...routerConfig[key],
        ...(key === localChain
          ? localTokenConfig
          : { type: TokenType.synthetic }),
        owner: owner.address,
      })) as ChainMap<TokenConfig & RouterConfig>;

      deployer = new HypERC20Deployer(multiProvider);
      contracts = await deployer.deploy(config);
      local = contracts[localChain].router;

      interchainGasPayment = await local.quoteGasPayment(remoteDomain);

      if (variant === TokenType.native) {
        interchainGasPayment = interchainGasPayment.add(amount);
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
      const mailboxAddress = core.contractsMap[localChain].mailbox.address;
      if (variant === TokenType.collateral) {
        const tokenAddress = await (local as HypERC20Collateral).wrappedToken();
        const token = ERC20__factory.connect(tokenAddress, owner);
        await token.transfer(local.address, totalSupply);
      } else if (variant === TokenType.native) {
        const remoteDomain = core.multiProvider.getDomainId(remoteChain);
        // deposit amount
        await local.transferRemote(
          remoteDomain,
          utils.addressToBytes32(remote.address),
          amount,
          { value: interchainGasPayment },
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
          value: interchainGasPayment,
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
      const interchainGasPaymaster = new InterchainGasPaymaster__factory()
        .attach(await local.interchainGasPaymaster())
        .connect(owner);
      await expect(
        local.transferRemote(
          remoteDomain,
          utils.addressToBytes32(recipient.address),
          amount,
          { value: interchainGasPayment },
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
      const value =
        variant === TokenType.native ? amount - 1 : interchainGasPayment;
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
          { value: interchainGasPayment },
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
