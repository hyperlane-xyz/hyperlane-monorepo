import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';
import sinon from 'sinon';

import { TestCcipReadIsm__factory } from '@hyperlane-xyz/core';
import { WithAddress } from '@hyperlane-xyz/utils';

import { HyperlaneCore } from '../../core/HyperlaneCore.js';
import { TestCoreDeployer } from '../../core/TestCoreDeployer.js';
import { TestRecipientDeployer } from '../../core/TestRecipientDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../../deploy/HyperlaneProxyFactoryDeployer.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { EvmIsmReader } from '../EvmIsmReader.js';
import { HyperlaneIsmFactory } from '../HyperlaneIsmFactory.js';
import { CCIPReadIsmConfig } from '../types.js';

import { BaseMetadataBuilder } from './builder.js';
import type { MetadataContext } from './types.js';

describe('CCIP-Read ISM Integration', () => {
  let core: HyperlaneCore;
  let multiProvider: MultiProvider;
  let testRecipient: any;
  let ccipReadIsm: any;
  let metadataBuilder: BaseMetadataBuilder;
  let ismFactory: HyperlaneIsmFactory;
  let fetchStub: sinon.SinonStub;
  const CCIP_READ_SERVER_URL = 'http://example.com/{data}';

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
      [[CCIP_READ_SERVER_URL]],
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
    const derivedIsm = (await new EvmIsmReader(
      multiProvider,
      'test2',
    ).deriveIsmConfig(ccipReadIsm.address)) as WithAddress<CCIPReadIsmConfig>;

    // Build the metadata using the CCIP-Read builder
    const context: MetadataContext<WithAddress<CCIPReadIsmConfig>> = {
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

  it('sends signature field in request when calling fetch', async () => {
    const { dispatchTx, message } = await core.sendMessage(
      'test1',
      'test2',
      testRecipient.address,
      '0x1234',
    );

    // Derive the on-chain ISM config for CCIP-Read
    const derivedIsm = (await new EvmIsmReader(
      multiProvider,
      'test2',
    ).deriveIsmConfig(ccipReadIsm.address)) as WithAddress<CCIPReadIsmConfig>;

    // Build the metadata using the CCIP-Read builder
    const context: MetadataContext<WithAddress<CCIPReadIsmConfig>> = {
      ism: derivedIsm,
      message,
      dispatchTx,
      hook: {} as any,
    };
    await metadataBuilder.build(context);

    // Verify that fetch was called exactly once
    expect(fetchStub.calledOnce).to.be.true;
    const [url, options] = fetchStub.getCall(0).args;
    const payload = JSON.parse(options.body as string);
    expect(url).to.equal(CCIP_READ_SERVER_URL.replace('{data}', payload.data));

    // Should include sender, data, and signature
    expect(payload).to.include.keys('sender', 'data', 'signature');
    expect(payload.sender).to.equal(ccipReadIsm.address);

    // Verify that signature is valid over (data, sender)
    const messageHash = ethers.utils.solidityKeccak256(
      ['string', 'address', 'bytes', 'string'],
      [
        'HYPERLANE_OFFCHAINLOOKUP',
        payload.sender,
        payload.data,
        CCIP_READ_SERVER_URL,
      ],
    );
    const recovered = ethers.utils.verifyMessage(
      ethers.utils.arrayify(messageHash),
      payload.signature,
    );
    expect(recovered).to.equal((await hre.ethers.getSigners())[0].address);
  });

  after(() => {
    fetchStub.restore();
  });
});
