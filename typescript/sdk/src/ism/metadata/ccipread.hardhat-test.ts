import { expect } from 'chai';
import hre from 'hardhat';
import sinon from 'sinon';

import { TestCcipReadIsm, TestCcipReadIsm__factory } from '@hyperlane-xyz/core';

import { HyperlaneCore } from '../../core/HyperlaneCore.js';
import { TestCoreDeployer } from '../../core/TestCoreDeployer.js';
import { TestRecipientDeployer } from '../../core/TestRecipientDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../../deploy/HyperlaneProxyFactoryDeployer.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { EvmIsmReader } from '../EvmIsmReader.js';
import { HyperlaneIsmFactory } from '../HyperlaneIsmFactory.js';

import { BaseMetadataBuilder } from './builder.js';

describe('Offchain Lookup ISM Integration', () => {
  let core: HyperlaneCore;
  let multiProvider: MultiProvider;
  let testRecipient: any;
  let ccipReadIsm: TestCcipReadIsm;
  let metadataBuilder: BaseMetadataBuilder;
  let ismFactory: HyperlaneIsmFactory;
  let fetchStub: sinon.SinonStub;

  before(async () => {
    // Set up a local test multi-provider and Hyperlane core
    const signers = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({
      signer: signers[0],
    });
    const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
    const contractsMap = await ismFactoryDeployer.deploy(
      multiProvider.mapKnownChains(() => ({})),
    );
    ismFactory = new HyperlaneIsmFactory(contractsMap, multiProvider);
    core = await new TestCoreDeployer(multiProvider, ismFactory).deployApp();

    // Deploy a TestRecipient on test1
    const deployments = await new TestRecipientDeployer(multiProvider).deploy({
      test2: {},
    });
    testRecipient = (deployments.test2 as any).testRecipient;

    // Deploy the TestCcipReadIsm on test1 domain
    const domain = multiProvider.getDomainId('test1');
    ccipReadIsm = await multiProvider.handleDeploy(
      domain,
      new TestCcipReadIsm__factory(),
      // Pass in desired offchain URLs for the ISM constructor:
      [['http://example.com/{data}']],
    );

    // Configure the TestRecipient to use the CCIP-Read ISM
    await testRecipient.setInterchainSecurityModule(ccipReadIsm.address);

    // Prepare the metadata builder
    metadataBuilder = new BaseMetadataBuilder(core);

    fetchStub = sinon.stub(global, 'fetch').resolves({
      ok: true,
      json: async () => ({
        data: '0x0000000000000000000000000000000000000000000000000000000000000001',
      }),
    } as Response);
  });

  it('should process a message protected by CCIP-Read ISM', async () => {
    // Send a message from test1 to test2
    const { dispatchTx, message } = await core.sendMessage(
      'test1',
      'test2',
      testRecipient.address,
      '0x1234',
    );

    // Derive the on-chain ISM config for CCIP-Read
    const derivedIsm = await new EvmIsmReader(
      multiProvider,
      'test2',
    ).deriveOffchainLookupConfig(ccipReadIsm.address);

    // Build the metadata using the CCIP-Read builder
    const context = {
      ism: derivedIsm,
      message,
      dispatchTx,
      hook: {} as any,
    };
    const metadata = await metadataBuilder.build(context);

    // Finally, call mailbox.process on test2 with the metadata and message
    const mailbox = core.getContracts('test2').mailbox;
    await expect(mailbox.process(metadata, message.message)).to.not.be.reverted;
  });

  after(() => {
    fetchStub.restore();
  });
});
