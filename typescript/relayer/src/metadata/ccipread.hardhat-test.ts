import '@nomiclabs/hardhat-waffle';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';
import sinon from 'sinon';

import {
  MockWormholeCore,
  MockWormholeCore__factory,
  TestCcipReadIsm,
  TestCcipReadIsm__factory,
  WormholeVaaHookIsm,
  WormholeVaaHookIsm__factory,
} from '@hyperlane-xyz/core';
import {
  DerivedIsmConfig,
  DispatchedMessage,
  EvmHookReader,
  EvmIsmReader,
  HyperlaneCore,
  HyperlaneIsmFactory,
  HyperlaneProxyFactoryDeployer,
  IsmType,
  MultiProvider,
  OffchainLookupIsmConfig,
  TestChainName,
  TestCoreDeployer,
  TestRecipientDeployer,
  WormholeConsistencyLevel,
  offchainLookupRequestMessageHash,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  WithAddress,
  addressToBytes32,
  assert,
} from '@hyperlane-xyz/utils';

import { HyperlaneRelayer } from '../core/HyperlaneRelayer.js';

import { BaseMetadataBuilder } from './builder.js';
import {
  MetadataBuildResult,
  MetadataContext,
  isMetadataBuildable,
} from './types.js';

const OFFCHAIN_LOOKUP_SERVER_URL = 'http://example.com/namespace';
const ORIGIN = TestChainName.test1;
const DESTINATION = TestChainName.test2;
const ORIGIN_WORMHOLE_CHAIN_ID = 2;
const DESTINATION_WORMHOLE_CHAIN_ID = 4;
const VAA_URL = 'https://ccip.example.com/wormhole/getWormholeVaa';
// Token-message shaped (recipient, amount) so an amount-routing ISM can route it.
const MESSAGE_BODY = ethers.utils.hexZeroPad('0x1234', 64);

function ccipReadLeaf(result: MetadataBuildResult): MetadataBuildResult {
  if ('modules' in result) {
    const [module] = result.modules;
    assert(module, `Missing submodule result for ${result.ismAddress}`);
    return ccipReadLeaf(module);
  }
  if ('selectedIsm' in result) return ccipReadLeaf(result.selectedIsm);
  return result;
}

interface RecipientIsmContext {
  ismAddress: Address;
  message: DispatchedMessage;
}

interface WormholeIsmCase {
  name: string;
  recipientIsm: (wormholeIsm: Address) => Promise<Address>;
  deriveIsm: (context: RecipientIsmContext) => Promise<DerivedIsmConfig>;
}

describe('Offchain Lookup ISM Integration', () => {
  let core: HyperlaneCore;
  let multiProvider: MultiProvider;
  let testRecipient: any;
  let ccipReadIsm: TestCcipReadIsm;
  let metadataBuilder: BaseMetadataBuilder;
  let ismFactory: HyperlaneIsmFactory;
  let fetchStub: sinon.SinonStub;

  beforeEach(async () => {
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
      [[OFFCHAIN_LOOKUP_SERVER_URL]],
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
    const result = await metadataBuilder.build(context);

    expect(isMetadataBuildable(result)).to.be.true;
    if (!isMetadataBuildable(result)) {
      throw new Error('Metadata should be buildable');
    }

    // Finally, call mailbox.process on test2 with the metadata and message
    const mailbox = core.getContracts('test2').mailbox;
    await expect(mailbox.process(result.metadata, message.message)).to.not.be
      .reverted;
  });

  it('sends signature and origin_tx_hash in POST request body', async () => {
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
    ).deriveIsmConfig(
      ccipReadIsm.address,
    )) as WithAddress<OffchainLookupIsmConfig>;

    // Build the metadata using the CCIP-Read builder
    const context: MetadataContext<WithAddress<OffchainLookupIsmConfig>> = {
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
    expect(url).to.equal(
      OFFCHAIN_LOOKUP_SERVER_URL.replace('{data}', payload.data),
    );

    expect(payload).to.include.keys(
      'sender',
      'data',
      'signature',
      'origin_tx_hash',
    );
    expect(payload.sender).to.equal(ccipReadIsm.address);
    expect(payload.origin_tx_hash).to.equal(dispatchTx.transactionHash);

    const recovered = ethers.utils.verifyMessage(
      ethers.utils.arrayify(
        offchainLookupRequestMessageHash(
          payload.sender,
          payload.data,
          OFFCHAIN_LOOKUP_SERVER_URL,
        ),
      ),
      payload.signature,
    );
    expect(recovered).to.equal((await hre.ethers.getSigners())[0].address);
  });

  describe('Wormhole ISM', () => {
    let originWormholeCore: MockWormholeCore;
    let originHookIsm: WormholeVaaHookIsm;
    let destinationHookIsm: WormholeVaaHookIsm;

    async function deployHookIsm(
      chain: TestChainName,
      wormholeChainId: number,
    ): Promise<{
      wormholeCore: MockWormholeCore;
      hookIsm: WormholeVaaHookIsm;
    }> {
      const wormholeCore = await multiProvider.handleDeploy(
        chain,
        new MockWormholeCore__factory(),
        [wormholeChainId, 0],
      );
      const hookIsm = await multiProvider.handleDeploy(
        chain,
        new WormholeVaaHookIsm__factory(),
        [
          core.getContracts(chain).mailbox.address,
          wormholeCore.address,
          {
            consistencyLevel: WormholeConsistencyLevel.Finalized,
            customConsistencyLevelContract: ethers.constants.AddressZero,
            customBaseConsistencyLevel: 0,
            additionalBlocks: 0,
          },
          [VAA_URL],
        ],
      );
      return { wormholeCore, hookIsm };
    }

    async function enrollPeer(
      chain: TestChainName,
      hookIsm: WormholeVaaHookIsm,
      peerChain: TestChainName,
      peer: WormholeVaaHookIsm,
      peerWormholeChainId: number,
    ): Promise<void> {
      await multiProvider.handleTx(
        chain,
        hookIsm[
          'enrollRemoteRouters((uint32,bytes32,uint16,uint8,uint8,uint16)[])'
        ]([
          {
            domainId: multiProvider.getDomainId(peerChain),
            domainIsm: addressToBytes32(peer.address),
            wormholeChainId: peerWormholeChainId,
            expectedConsistencyLevel: WormholeConsistencyLevel.Finalized,
            expectedCustomBaseConsistencyLevel: 0,
            expectedAdditionalBlocks: 0,
          },
        ]),
      );
    }

    beforeEach(async () => {
      const origin = await deployHookIsm(ORIGIN, ORIGIN_WORMHOLE_CHAIN_ID);
      originWormholeCore = origin.wormholeCore;
      originHookIsm = origin.hookIsm;
      destinationHookIsm = (
        await deployHookIsm(DESTINATION, DESTINATION_WORMHOLE_CHAIN_ID)
      ).hookIsm;
      await enrollPeer(
        ORIGIN,
        originHookIsm,
        DESTINATION,
        destinationHookIsm,
        DESTINATION_WORMHOLE_CHAIN_ID,
      );
      await enrollPeer(
        DESTINATION,
        destinationHookIsm,
        ORIGIN,
        originHookIsm,
        ORIGIN_WORMHOLE_CHAIN_ID,
      );
    });

    const viaRelayer = ({ message }: RecipientIsmContext) =>
      new HyperlaneRelayer({ core }).getRecipientIsmConfig(message);
    // Without a message context the reader keeps routing ISMs, so the routing
    // metadata builder derives the routed module itself.
    const viaIsmReader = ({ ismAddress }: RecipientIsmContext) =>
      new EvmIsmReader(multiProvider, DESTINATION).deriveIsmConfig(ismAddress);

    const cases: WormholeIsmCase[] = [
      {
        name: 'standalone',
        recipientIsm: async (wormholeIsm) => wormholeIsm,
        deriveIsm: viaRelayer,
      },
      {
        name: 'nested in an aggregation ism',
        recipientIsm: async (wormholeIsm) =>
          (
            await ismFactory.deploy({
              destination: DESTINATION,
              config: {
                type: IsmType.AGGREGATION,
                modules: [wormholeIsm],
                threshold: 1,
              },
            })
          ).address,
        deriveIsm: viaRelayer,
      },
      {
        name: 'nested in an aggregation ism behind an amount-routing ism derived without message context',
        recipientIsm: async (wormholeIsm) => {
          const aggregation = (
            await ismFactory.deploy({
              destination: DESTINATION,
              config: {
                type: IsmType.AGGREGATION,
                modules: [wormholeIsm],
                threshold: 1,
              },
            })
          ).address;
          return (
            await ismFactory.deploy({
              destination: DESTINATION,
              config: {
                type: IsmType.AMOUNT_ROUTING,
                lowerIsm: aggregation,
                upperIsm: aggregation,
                threshold: 1,
              },
            })
          ).address;
        },
        deriveIsm: viaIsmReader,
      },
      {
        name: 'nested in a routing ism',
        recipientIsm: async (wormholeIsm) =>
          (
            await ismFactory.deploy({
              destination: DESTINATION,
              config: {
                type: IsmType.ROUTING,
                owner: await multiProvider.getSignerAddress(DESTINATION),
                domains: { [ORIGIN]: wormholeIsm },
              },
            })
          ).address,
        deriveIsm: viaRelayer,
      },
    ];

    for (const { name, recipientIsm, deriveIsm } of cases) {
      it(`builds metadata for a wormhole ism ${name}`, async () => {
        const ismAddress = await recipientIsm(destinationHookIsm.address);
        await multiProvider.handleTx(
          DESTINATION,
          testRecipient.setInterchainSecurityModule(ismAddress),
        );
        const { dispatchTx, message } = await core.sendMessage(
          ORIGIN,
          DESTINATION,
          testRecipient.address,
          MESSAGE_BODY,
          originHookIsm.address,
        );
        const [published] = await originWormholeCore.queryFilter(
          originWormholeCore.filters.LogMessagePublished(),
          dispatchTx.blockHash,
        );
        assert(published, `Missing Wormhole publication for ${message.id}`);
        const vaa = await originWormholeCore.encodeVaa({
          emitterChainId: ORIGIN_WORMHOLE_CHAIN_ID,
          emitterAddress: addressToBytes32(originHookIsm.address),
          sequence: published.args.sequence,
          nonce: published.args.nonce,
          consistencyLevel: published.args.consistencyLevel,
          guardianSetIndex: 0,
          payload: published.args.payload,
        });
        const vaaMetadata = ethers.utils.defaultAbiCoder.encode(
          ['bytes'],
          [vaa],
        );
        fetchStub.callsFake(
          async () =>
            new Response(JSON.stringify({ data: vaaMetadata }), {
              status: 200,
            }),
        );
        const context: MetadataContext = {
          ism: await deriveIsm({ ismAddress, message }),
          hook: await new EvmHookReader(multiProvider, ORIGIN).deriveHookConfig(
            originHookIsm.address,
          ),
          message,
          dispatchTx,
        };

        const result = await metadataBuilder.build(context);

        const leaf = ccipReadLeaf(result);
        expect(leaf.type).to.equal(IsmType.WORMHOLE);
        expect(leaf.ismAddress).to.equal(destinationHookIsm.address);
        assert('urls' in leaf, `Missing CCIP-read urls for ${leaf.ismAddress}`);
        expect(leaf.urls).to.deep.equal([VAA_URL]);
        expect(leaf.metadata).to.equal(vaaMetadata);
        assert(isMetadataBuildable(result), `Unbuildable metadata for ${name}`);

        const mailbox = core.getContracts(DESTINATION).mailbox;
        await multiProvider.handleTx(
          DESTINATION,
          mailbox.process(result.metadata, message.message),
        );
        expect(await mailbox.delivered(message.id)).to.equal(true);
      });
    }
  });

  afterEach(() => {
    fetchStub.restore();
  });
});
