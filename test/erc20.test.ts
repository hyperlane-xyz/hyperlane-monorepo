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

import { Erc20TokenConfig, HypERC20Config } from '../src/config';
import { HypERC20Contracts } from '../src/contracts';
import { HypERC20Deployer } from '../src/deploy';
import { HypERC20 } from '../src/types';

const localChain = 'test1';
const remoteChain = 'test2';
const localDomain = ChainNameToDomainId[localChain];
const remoteDomain = ChainNameToDomainId[remoteChain];
const totalSupply = 3000;
const amount = 10;
const testInterchainGasPayment = 123456789;

const tokenConfig: Erc20TokenConfig = {
  name: 'HypERC20',
  symbol: 'HYP',
  totalSupply,
};

describe('HypERC20', async () => {
  let owner: SignerWithAddress;
  let recipient: SignerWithAddress;
  let core: TestCoreApp;
  let deployer: HypERC20Deployer<TestChainNames>;
  let contracts: Record<TestChainNames, HypERC20Contracts>;
  let local: HypERC20;
  let remote: HypERC20;

  before(async () => {
    [owner, recipient] = await ethers.getSigners();
    const multiProvider = getTestMultiProvider(owner);

    const coreDeployer = new TestCoreDeployer(multiProvider);
    const coreContractsMaps = await coreDeployer.deploy();
    core = new TestCoreApp(coreContractsMaps, multiProvider);
    const config = core.extendWithConnectionClientConfig(
      getChainToOwnerMap(testChainConnectionConfigs, owner.address),
    );
    const configWithTokenInfo: ChainMap<TestChainNames, HypERC20Config> =
      objMap(config, (key) => ({
        ...config[key],
        ...tokenConfig,
      }));
    deployer = new HypERC20Deployer(multiProvider, configWithTokenInfo, core);
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

  it('should mint total supply to deployer', async () => {
    await expectBalance(local, recipient, 0);
    await expectBalance(local, owner, totalSupply);
    await expectBalance(remote, recipient, 0);
    await expectBalance(remote, owner, totalSupply);
  });

  it('should allow for local transfers', async () => {
    await local.transfer(recipient.address, amount);
    await expectBalance(local, recipient, amount);
    await expectBalance(local, owner, totalSupply - amount);
    await expectBalance(remote, recipient, 0);
    await expectBalance(remote, owner, totalSupply);
  });

  it('should allow for remote transfers', async () => {
    await local.transferRemote(remoteDomain, recipient.address, amount);

    await expectBalance(local, recipient, amount);
    await expectBalance(local, owner, totalSupply - amount * 2);
    await expectBalance(remote, recipient, 0);
    await expectBalance(remote, owner, totalSupply);

    await core.processMessages();

    await expectBalance(local, recipient, amount);
    await expectBalance(local, owner, totalSupply - amount * 2);
    await expectBalance(remote, recipient, amount);
    await expectBalance(remote, owner, totalSupply);
  });

  it('allows interchain gas payment for remote transfers', async () => {
    const outbox = core.getMailboxPair(localChain, remoteChain).originOutbox;
    const interchainGasPaymaster =
      core.contractsMap[localChain].interchainGasPaymaster.contract;
    const leafIndex = await outbox.count();
    await expect(
      local.transferRemote(remoteDomain, recipient.address, amount, {
        value: testInterchainGasPayment,
      }),
    )
      .to.emit(interchainGasPaymaster, 'GasPayment')
      .withArgs(outbox.address, leafIndex, testInterchainGasPayment);
  });

  it('should emit TransferRemote events', async () => {
    expect(await local.transferRemote(remoteDomain, recipient.address, amount))
      .to.emit(local, 'SentTransferRemote')
      .withArgs(remoteDomain, recipient.address, amount);
    expect(await core.processMessages())
      .to.emit(local, 'ReceivedTransferRemote')
      .withArgs(localDomain, recipient.address, amount);
  });
});

const expectBalance = async (
  token: HypERC20,
  signer: SignerWithAddress,
  balance: number,
) => expect(await token.balanceOf(signer.address)).to.eq(balance);
