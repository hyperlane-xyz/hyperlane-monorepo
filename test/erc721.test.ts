import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import '@nomiclabs/hardhat-waffle';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
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
  HypERC721CollateralConfig,
  HypERC721Config,
  SyntheticConfig,
  TokenType,
} from '../src/config';
import { HypERC721Contracts } from '../src/contracts';
import { HypERC721Deployer } from '../src/deploy';
import {
  ERC721,
  ERC721Test__factory,
  ERC721__factory,
  HypERC721,
  HypERC721Collateral,
  HypERC721URICollateral,
  HypERC721URIStorage,
} from '../src/types';

const localChain = 'test1';
const remoteChain = 'test2';
const localDomain = ChainNameToDomainId[localChain];
const remoteDomain = ChainNameToDomainId[remoteChain];
const totalSupply = 50;
const tokenId = 10;
const tokenId2 = 20;
const tokenId3 = 30;
const tokenId4 = 40;
const testInterchainGasPayment = 123456789;
const gas = 67628;

for (const withCollateral of [true, false]) {
  for (const withUri of [true, false]) {
    const tokenConfig: SyntheticConfig = {
      type: withUri ? TokenType.syntheticUri : TokenType.synthetic,
      name: 'HypERC721',
      symbol: 'HYP',
      totalSupply,
    };

    const configMap = {
      test1: {
        ...tokenConfig,
        totalSupply,
        gas,
      },
      test2: {
        ...tokenConfig,
        totalSupply: 0,
        gas,
      },
      test3: {
        ...tokenConfig,
        totalSupply: 0,
        gas,
      },
    };
    describe(`HypERC721${withUri ? 'URI' : ''}${
      withCollateral ? 'Collateral' : ''
    }`, async () => {
      let owner: SignerWithAddress;
      let recipient: SignerWithAddress;
      let core: TestCoreApp;
      let deployer: HypERC721Deployer<TestChainNames>;
      let contracts: Record<TestChainNames, HypERC721Contracts>;
      let local: HypERC721 | HypERC721Collateral | HypERC721URICollateral;
      let remote: HypERC721 | HypERC721Collateral | HypERC721URIStorage;

      beforeEach(async () => {
        [owner, recipient] = await ethers.getSigners();
        const multiProvider = getTestMultiProvider(owner);

        const coreDeployer = new TestCoreDeployer(multiProvider);
        const coreContractsMaps = await coreDeployer.deploy();
        core = new TestCoreApp(coreContractsMaps, multiProvider);
        const coreConfig = core.getConnectionClientConfigMap();
        const configWithTokenInfo: ChainMap<
          TestChainNames,
          HypERC721Config | HypERC721CollateralConfig
        > = objMap(coreConfig, (key) => ({
          ...coreConfig[key],
          ...configMap[key],
          owner: owner.address,
          gas,
        }));

        let erc721: ERC721 | undefined;
        if (withCollateral) {
          erc721 = await new ERC721Test__factory(owner).deploy(
            tokenConfig.name,
            tokenConfig.symbol,
            tokenConfig.totalSupply,
          );
          configWithTokenInfo.test1 = {
            ...configWithTokenInfo.test1,
            type: withUri ? TokenType.collateralUri : TokenType.collateral,
            token: erc721.address,
          };
        }

        deployer = new HypERC721Deployer(
          multiProvider,
          configWithTokenInfo,
          core,
        );
        contracts = await deployer.deploy();
        local = contracts[localChain].router;
        if (withCollateral) {
          // approve wrapper to transfer tokens
          await erc721!.approve(local.address, tokenId);
          await erc721!.approve(local.address, tokenId2);
          await erc721!.approve(local.address, tokenId3);
          await erc721!.approve(local.address, tokenId4);
        }

        remote = contracts[remoteChain].router;
      });

      it('should not be initializable again', async () => {
        const initializeTx = withCollateral
          ? (local as HypERC721Collateral).initialize(
              ethers.constants.AddressZero,
              ethers.constants.AddressZero,
            )
          : (local as HypERC721).initialize(
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

      it('should mint total supply to deployer on local domain', async () => {
        await expectBalance(local, recipient, 0);
        await expectBalance(local, owner, totalSupply);
        await expectBalance(remote, recipient, 0);
        await expectBalance(remote, owner, 0);
      });

      // do not test underlying ERC721 collateral functionality
      if (!withCollateral) {
        it('should allow for local transfers', async () => {
          await (local as HypERC721).transferFrom(
            owner.address,
            recipient.address,
            tokenId,
          );
          await expectBalance(local, recipient, 1);
          await expectBalance(local, owner, totalSupply - 1);
          await expectBalance(remote, recipient, 0);
          await expectBalance(remote, owner, 0);
        });
      }

      it('should not allow transfers of nonexistent identifiers', async () => {
        const invalidTokenId = totalSupply + 10;
        if (!withCollateral) {
          await expect(
            (local as HypERC721).transferFrom(
              owner.address,
              recipient.address,
              invalidTokenId,
            ),
          ).to.be.revertedWith('ERC721: invalid token ID');
        }
        await expect(
          local.transferRemote(
            remoteDomain,
            utils.addressToBytes32(recipient.address),
            invalidTokenId,
            { value: gas },
          ),
        ).to.be.revertedWith('ERC721: invalid token ID');
      });

      it('should allow for remote transfers', async () => {
        await local.transferRemote(
          remoteDomain,
          utils.addressToBytes32(recipient.address),
          tokenId2,
          { value: gas },
        );

        await expectBalance(local, recipient, 0);
        await expectBalance(local, owner, totalSupply - 1);
        await expectBalance(remote, recipient, 0);
        await expectBalance(remote, owner, 0);

        await core.processMessages();

        await expectBalance(local, recipient, 0);
        await expectBalance(local, owner, totalSupply - 1);
        await expectBalance(remote, recipient, 1);
        await expectBalance(remote, owner, 0);
      });

      if (withUri && withCollateral) {
        it('should relay URI with remote transfer', async () => {
          const remoteUri = remote as HypERC721URIStorage;
          await expect(remoteUri.tokenURI(tokenId2)).to.be.revertedWith('');

          await local.transferRemote(
            remoteDomain,
            utils.addressToBytes32(recipient.address),
            tokenId2,
            { value: gas },
          );

          await expect(remoteUri.tokenURI(tokenId2)).to.be.revertedWith('');

          await core.processMessages();

          expect(await remoteUri.tokenURI(tokenId2)).to.equal(
            `TEST-BASE-URI${tokenId2}`,
          );
        });
      }

      it('should prevent remote transfer of unowned id', async () => {
        const revertReason = withCollateral
          ? 'ERC721: transfer from incorrect owner'
          : '!owner';
        await expect(
          local
            .connect(recipient)
            .transferRemote(
              remoteDomain,
              utils.addressToBytes32(recipient.address),
              tokenId2,
              { value: gas },
            ),
        ).to.be.revertedWith(revertReason);
      });

      it('benchmark handle gas overhead', async () => {
        const localRaw = local.connect(ethers.provider);
        const mailboxAddress =
          core.contractsMap[localChain].mailbox.contract.address;
        let tokenIdToUse: number;
        if (withCollateral) {
          const tokenAddress = await (
            local as HypERC721Collateral
          ).wrappedToken();
          const token = ERC721__factory.connect(tokenAddress, owner);
          await token.transferFrom(owner.address, local.address, tokenId);
          tokenIdToUse = tokenId;
        } else {
          tokenIdToUse = totalSupply + 1;
        }
        const message = `${utils.addressToBytes32(
          recipient.address,
        )}${BigNumber.from(tokenIdToUse)
          .toHexString()
          .slice(2)
          .padStart(64, '0')}`;
        try {
          const gas = await localRaw.estimateGas.handle(
            remoteDomain,
            utils.addressToBytes32(remote.address),
            message,
            { from: mailboxAddress },
          );
          console.log(gas);
        } catch (e) {
          console.log('FAILED');
        }
      });

      it('allows interchain gas payment for remote transfers', async () => {
        const interchainGasPaymaster =
          core.contractsMap[localChain].interchainGasPaymaster.contract;
        await expect(
          local.transferRemote(
            remoteDomain,
            utils.addressToBytes32(recipient.address),
            tokenId3,
            {
              value: testInterchainGasPayment,
            },
          ),
        ).to.emit(interchainGasPaymaster, 'GasPayment');
      });

      it('should emit TransferRemote events', async () => {
        expect(
          await local.transferRemote(
            remoteDomain,
            utils.addressToBytes32(recipient.address),
            tokenId4,
            { value: gas },
          ),
        )
          .to.emit(local, 'SentTransferRemote')
          .withArgs(remoteDomain, recipient.address, tokenId4);
        expect(await core.processMessages())
          .to.emit(local, 'ReceivedTransferRemote')
          .withArgs(localDomain, recipient.address, tokenId4);
      });
    });
  }
}

const expectBalance = async (
  token: HypERC721 | HypERC721Collateral | ERC721,
  signer: SignerWithAddress,
  balance: number,
) => {
  if (Object.keys(token.interface.functions).includes('wrappedToken()')) {
    const wrappedToken = await (token as HypERC721Collateral).wrappedToken();
    token = ERC721__factory.connect(wrappedToken, signer);
  }
  return expectTokenBalance(token as HypERC721, signer, balance);
};

const expectTokenBalance = async (
  token: ERC721,
  signer: SignerWithAddress,
  balance: number,
) => expect(await token.balanceOf(signer.address)).to.eq(balance);
