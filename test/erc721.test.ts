import { InterchainGasPaymaster, Outbox } from '@abacus-network/core';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { abacus, ethers } from 'hardhat';
import { AbcERC721 } from '../types';
import { AbcERC721Deploy } from './erc721.deploy';

const localDomain = 1000;
const remoteDomain = 2000;
const mintAmount = 50;
const domains = [localDomain, remoteDomain];

describe('AbcERC721', async () => {
  let owner: SignerWithAddress,
    recipient: SignerWithAddress,
    router: AbcERC721,
    remote: AbcERC721,
    outbox: Outbox,
    interchainGasPaymaster: InterchainGasPaymaster,
    token: AbcERC721Deploy;
  const testInterchainGasPayment = 123456789;

  before(async () => {
    [owner, recipient] = await ethers.getSigners();
    await abacus.deploy(domains, owner);
  });

  beforeEach(async () => {
    const defaultConfig = {
      signer: owner,
      name: 'AbcERC721',
      symbol: 'ABC',
    };
    const configMap = {
      [localDomain]: {
        ...defaultConfig,
        mintAmount,
      },
      [remoteDomain]: {
        ...defaultConfig,
        mintAmount: 0,
      },
    };

    token = new AbcERC721Deploy(configMap);
    await token.deploy(abacus);
    router = token.router(localDomain);
    remote = token.router(remoteDomain);
    outbox = abacus.outbox(localDomain);
    interchainGasPaymaster = abacus.interchainGasPaymaster(localDomain);
  });

  const expectBalance = async (
    token: AbcERC721,
    signer: SignerWithAddress,
    balance: number,
  ) => expect(await token.balanceOf(signer.address)).to.eq(balance);

  const tokenId = mintAmount / 2;

  it('should not be initializable again', async () => {
    await expect(
      router.initialize(ethers.constants.AddressZero, 0, '', ''),
    ).to.be.revertedWith('Initializable: contract is already initialized');
  });

  it('should mint total supply to deployer on local domain', async () => {
    await expectBalance(router, recipient, 0);
    await expectBalance(router, owner, mintAmount);
    await expectBalance(remote, recipient, 0);
    await expectBalance(remote, owner, 0);
  });

  it('should allow for local transfers', async () => {
    await router.transferFrom(owner.address, recipient.address, tokenId);
    await expectBalance(router, recipient, 1);
    await expectBalance(router, owner, mintAmount - 1);
    await expectBalance(remote, recipient, 0);
    await expectBalance(remote, owner, 0);
  });

  it('should not allow transfers of nonexistent identifiers', async () => {
    const invalidTokenId = mintAmount + 1;
    await expect(
      router.transferFrom(owner.address, recipient.address, invalidTokenId),
    ).to.be.revertedWith('ERC721: operator query for nonexistent token');
    await expect(
      router.transferRemote(remoteDomain, recipient.address, invalidTokenId),
    ).to.be.revertedWith('ERC721: owner query for nonexistent token');
  });

  it('should allow for remote transfers', async () => {
    const amount = mintAmount / 10;
    for (let id = 0; id < amount; id++) {
      await router.transferRemote(remoteDomain, recipient.address, id);
    }

    await expectBalance(router, recipient, 0);
    await expectBalance(router, owner, mintAmount - amount);
    await expectBalance(remote, recipient, 0);
    await expectBalance(remote, owner, 0);

    await abacus.processMessages();

    await expectBalance(router, recipient, 0);
    await expectBalance(router, owner, mintAmount - amount);
    await expectBalance(remote, recipient, amount);
    await expectBalance(remote, owner, 0);
  });

  it('allows interchain gas payment for remote transfers', async () => {
    const leafIndex = await outbox.count();
    await expect(
      router.transferRemote(remoteDomain, recipient.address, tokenId, {
        value: testInterchainGasPayment,
      }),
    )
      .to.emit(interchainGasPaymaster, 'GasPayment')
      .withArgs(leafIndex, testInterchainGasPayment);
  });

  it('should emit TransferRemote events', async () => {
    expect(
      await router.transferRemote(remoteDomain, recipient.address, tokenId),
    )
      .to.emit(router, 'SentTransferRemote')
      .withArgs(remoteDomain, recipient.address, tokenId);
    expect(await abacus.processMessages())
      .to.emit(router, 'ReceivedTransferRemote')
      .withArgs(localDomain, recipient.address, tokenId);
  });
});
