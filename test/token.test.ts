import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { abacus, ethers } from 'hardhat';
import { AbcToken } from '../types';
import { TokenConfig, TokenDeploy } from './TokenDeploy';
import { Outbox, InterchainGasPaymaster } from '@abacus-network/core';

const localDomain = 1000;
const remoteDomain = 2000;
const totalSupply = 3000;
const domains = [localDomain, remoteDomain];

describe('AbcToken', async () => {
  let owner: SignerWithAddress,
    recipient: SignerWithAddress,
    router: AbcToken,
    remote: AbcToken,
    outbox: Outbox,
    interchainGasPaymaster: InterchainGasPaymaster,
    token: TokenDeploy;
  const testInterchainGasPayment = 123456789;

  before(async () => {
    [owner, recipient] = await ethers.getSigners();
    await abacus.deploy(domains, owner);
  });

  beforeEach(async () => {
    const config: TokenConfig = {
      signer: owner,
      name: 'AbcToken',
      symbol: 'ABC',
      totalSupply,
    };
    token = new TokenDeploy(config);
    await token.deploy(abacus);
    router = token.router(localDomain);
    remote = token.router(remoteDomain);
    outbox = abacus.outbox(localDomain);
    interchainGasPaymaster = abacus.interchainGasPaymaster(localDomain);
  });

  const expectBalance = async (
    token: AbcToken,
    signer: SignerWithAddress,
    balance: number,
  ) => expect(await token.balanceOf(signer.address)).to.eq(balance);

  const amount = 10;

  it('should not be initializable again', async () => {
    await expect(
      router.initialize(ethers.constants.AddressZero, 0, '', ''),
    ).to.be.revertedWith('Initializable: contract is already initialized');
  });

  it('should mint total supply to deployer', async () => {
    await expectBalance(router, recipient, 0);
    await expectBalance(router, owner, totalSupply);
    await expectBalance(remote, recipient, 0);
    await expectBalance(remote, owner, totalSupply);
  });

  it('should allow for local transfers', async () => {
    await router.transfer(recipient.address, amount);
    await expectBalance(router, recipient, amount);
    await expectBalance(router, owner, totalSupply - amount);
    await expectBalance(remote, recipient, 0);
    await expectBalance(remote, owner, totalSupply);
  });

  it('should allow for remote transfers', async () => {
    await router.transferRemote(remoteDomain, recipient.address, amount);

    await expectBalance(router, recipient, 0);
    await expectBalance(router, owner, totalSupply - amount);
    await expectBalance(remote, recipient, 0);
    await expectBalance(remote, owner, totalSupply);

    await abacus.processMessages();

    await expectBalance(router, recipient, 0);
    await expectBalance(router, owner, totalSupply - amount);
    await expectBalance(remote, recipient, amount);
    await expectBalance(remote, owner, totalSupply);
  });

  it('allows interchain gas payment for remote transfers', async () => {
    const leafIndex = await outbox.count();
    await expect(
      router.transferRemote(remoteDomain, recipient.address, amount, {
        value: testInterchainGasPayment,
      }),
    )
      .to.emit(interchainGasPaymaster, 'GasPayment')
      .withArgs(leafIndex, testInterchainGasPayment);
  });

  it('should emit TransferRemote events', async () => {
    expect(await router.transferRemote(remoteDomain, recipient.address, amount))
      .to.emit(router, 'SentTransferRemote')
      .withArgs(remoteDomain, recipient.address, amount);
    expect(await abacus.processMessages())
      .to.emit(router, 'ReceivedTransferRemote')
      .withArgs(localDomain, recipient.address, amount);
  });
});
