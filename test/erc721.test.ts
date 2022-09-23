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
  getChainToOwnerMap,
  getTestMultiProvider,
  objMap,
  testChainConnectionConfigs,
} from '@hyperlane-xyz/sdk';

import { Erc721TokenConfig, HypERC721Config } from '../src/config';
import { HypERC721Contracts } from '../src/contracts';
import { HypERC721Deployer } from '../src/deploy';
import { HypERC721 } from '../src/types';

const localChain = 'test1';
const remoteChain = 'test2';
const localDomain = ChainNameToDomainId[localChain];
const remoteDomain = ChainNameToDomainId[remoteChain];
const mintAmount = 50;
const tokenId = 10;
const tokenId2 = 20;
const tokenId3 = 30;
const tokenId4 = 40;
const testInterchainGasPayment = 123456789;

const tokenConfig: Erc721TokenConfig = {
  name: 'HypERC721',
  symbol: 'HYP',
  mintAmount,
};

const configMap = {
  test1: {
    ...tokenConfig,
    mintAmount,
  },
  test2: {
    ...tokenConfig,
    mintAmount: 0,
  },
  test3: {
    ...tokenConfig,
    mintAmount: 0,
  },
};

describe('HypERC721', async () => {
  let owner: SignerWithAddress;
  let recipient: SignerWithAddress;
  let core: TestCoreApp;
  let deployer: HypERC721Deployer<TestChainNames>;
  let contracts: Record<TestChainNames, HypERC721Contracts>;
  let local: HypERC721;
  let remote: HypERC721;

  before(async () => {
    [owner, recipient] = await ethers.getSigners();
    const multiProvider = getTestMultiProvider(owner);

    const coreDeployer = new TestCoreDeployer(multiProvider);
    const coreContractsMaps = await coreDeployer.deploy();
    core = new TestCoreApp(coreContractsMaps, multiProvider);
    const coreConfig = core.extendWithConnectionClientConfig(
      getChainToOwnerMap(testChainConnectionConfigs, owner.address),
    );
    const configWithTokenInfo: ChainMap<TestChainNames, HypERC721Config> =
      objMap(coreConfig, (key) => ({
        ...coreConfig[key],
        ...configMap[key],
      }));
    deployer = new HypERC721Deployer(multiProvider, configWithTokenInfo, core);
    contracts = await deployer.deploy();
    local = contracts[localChain].router;
    remote = contracts[remoteChain].router;
  });

  it('should not be initializable again', async () => {
    await expect(
      local.initialize(
        ethers.constants.AddressZero,
        ethers.constants.AddressZero,
        0,
        '',
        '',
      ),
    ).to.be.revertedWith('Initializable: contract is already initialized');
  });

  it('should mint total supply to deployer on local domain', async () => {
    await expectBalance(local, recipient, 0);
    await expectBalance(local, owner, mintAmount);
    await expectBalance(remote, recipient, 0);
    await expectBalance(remote, owner, 0);
  });

  it('should allow for local transfers', async () => {
    await local.transferFrom(owner.address, recipient.address, tokenId);
    await expectBalance(local, recipient, 1);
    await expectBalance(local, owner, mintAmount - 1);
    await expectBalance(remote, recipient, 0);
    await expectBalance(remote, owner, 0);
  });

  it('should not allow transfers of nonexistent identifiers', async () => {
    const invalidTokenId = mintAmount + 10;
    await expect(
      local.transferFrom(owner.address, recipient.address, invalidTokenId),
    ).to.be.revertedWith('ERC721: invalid token ID');
    await expect(
      local.transferRemote(remoteDomain, recipient.address, invalidTokenId),
    ).to.be.revertedWith('ERC721: invalid token ID');
  });

  it('should allow for remote transfers', async () => {
    await local.transferRemote(remoteDomain, recipient.address, tokenId2);

    await expectBalance(local, recipient, 1);
    await expectBalance(local, owner, mintAmount - 2);
    await expectBalance(remote, recipient, 0);
    await expectBalance(remote, owner, 0);

    await core.processMessages();

    await expectBalance(local, recipient, 1);
    await expectBalance(local, owner, mintAmount - 2);
    await expectBalance(remote, recipient, 1);
    await expectBalance(remote, owner, 0);
  });

  it('allows interchain gas payment for remote transfers', async () => {
    const outbox = core.getMailboxPair(localChain, remoteChain).originOutbox;
    const interchainGasPaymaster =
      core.contractsMap[localChain].interchainGasPaymaster.contract;
    const leafIndex = await outbox.count();
    await expect(
      local.transferRemote(remoteDomain, recipient.address, tokenId3, {
        value: testInterchainGasPayment,
      }),
    )
      .to.emit(interchainGasPaymaster, 'GasPayment')
      .withArgs(outbox.address, leafIndex, testInterchainGasPayment);
  });

  it('should emit TransferRemote events', async () => {
    expect(
      await local.transferRemote(remoteDomain, recipient.address, tokenId4),
    )
      .to.emit(local, 'SentTransferRemote')
      .withArgs(remoteDomain, recipient.address, tokenId4);
    expect(await core.processMessages())
      .to.emit(local, 'ReceivedTransferRemote')
      .withArgs(localDomain, recipient.address, tokenId4);
  });
});

const expectBalance = async (
  token: HypERC721,
  signer: SignerWithAddress,
  balance: number,
) => expect(await token.balanceOf(signer.address)).to.eq(balance);
