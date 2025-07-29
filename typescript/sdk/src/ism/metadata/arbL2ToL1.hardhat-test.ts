import { ChildToParentMessageStatus } from '@arbitrum/sdk';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import hre from 'hardhat';
import sinon from 'sinon';

import {
  ArbL2ToL1Hook,
  ArbL2ToL1Hook__factory,
  ArbL2ToL1Ism,
  ArbL2ToL1Ism__factory,
  MockArbBridge,
  MockArbBridge__factory,
  MockArbSys__factory,
  TestRecipient,
} from '@hyperlane-xyz/core';
import {
  Address,
  WithAddress,
  bytes32ToAddress,
  objMap,
} from '@hyperlane-xyz/utils';

import { testChains } from '../../consts/testChains.js';
import {
  HyperlaneAddresses,
  HyperlaneContracts,
} from '../../contracts/types.js';
import { HyperlaneCore } from '../../core/HyperlaneCore.js';
import { TestCoreDeployer } from '../../core/TestCoreDeployer.js';
import { TestRecipientDeployer } from '../../core/TestRecipientDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../../deploy/HyperlaneProxyFactoryDeployer.js';
import { ProxyFactoryFactories } from '../../deploy/contracts.js';
import { EvmHookModule } from '../../hook/EvmHookModule.js';
import { ArbL2ToL1HookConfig, HookType } from '../../hook/types.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { ChainMap, ChainName } from '../../types.js';
import { EvmIsmReader } from '../EvmIsmReader.js';
import { HyperlaneIsmFactory } from '../HyperlaneIsmFactory.js';
import { ArbL2ToL1IsmConfig } from '../types.js';

import { ArbL2ToL1MetadataBuilder } from './arbL2ToL1.js';
import { MetadataContext } from './types.js';

describe('ArbL2ToL1MetadataBuilder', () => {
  const origin: ChainName = 'test4';
  const destination: ChainName = 'test2';
  let core: HyperlaneCore;
  let ismFactory: HyperlaneIsmFactory;
  let hookConfig: ChainMap<ArbL2ToL1HookConfig>;
  let arbL2ToL1Hook: ArbL2ToL1Hook;
  let arbL2ToL1Ism: ArbL2ToL1Ism;
  let arbBridge: MockArbBridge;
  let testRecipients: Record<ChainName, TestRecipient>;
  let proxyFactoryAddresses: HyperlaneAddresses<ProxyFactoryFactories>;
  let factoryContracts: HyperlaneContracts<ProxyFactoryFactories>;
  let relayer: SignerWithAddress;
  let metadataBuilder: ArbL2ToL1MetadataBuilder;
  let context: MetadataContext<
    WithAddress<ArbL2ToL1IsmConfig>,
    WithAddress<ArbL2ToL1HookConfig>
  >;

  function setArbitrumBridgeStatus(status: ChildToParentMessageStatus) {
    sinon
      .stub(metadataBuilder, 'getArbitrumBridgeStatus')
      .callsFake(async (): Promise<ChildToParentMessageStatus> => {
        return status;
      });
  }

  before(async () => {
    [relayer] = await hre.ethers.getSigners();
    const multiProvider = MultiProvider.createTestMultiProvider({
      signer: relayer,
    });
    const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
    const contractsMap = await ismFactoryDeployer.deploy(
      multiProvider.mapKnownChains(() => ({})),
    );
    ismFactory = new HyperlaneIsmFactory(contractsMap, multiProvider);
    const coreDeployer = new TestCoreDeployer(multiProvider, ismFactory);
    const recipientDeployer = new TestRecipientDeployer(multiProvider);
    testRecipients = objMap(
      await recipientDeployer.deploy(
        Object.fromEntries(testChains.map((c) => [c, {}])),
      ),
      (_, { testRecipient }) => testRecipient,
    );
    core = await coreDeployer.deployApp();

    const mockArbSys = await multiProvider.handleDeploy(
      origin,
      new MockArbSys__factory(),
      [],
    );
    hookConfig = {
      test4: {
        type: HookType.ARB_L2_TO_L1,
        arbSys: mockArbSys.address,
        destinationChain: destination,
        childHook: {
          type: HookType.INTERCHAIN_GAS_PAYMASTER,
          beneficiary: relayer.address,
          owner: relayer.address,
          oracleKey: relayer.address,
          overhead: {
            [destination]: 200000,
          },
          oracleConfig: {
            [destination]: {
              gasPrice: '20',
              tokenExchangeRate: '10000000000',
            },
          },
        },
      },
    };

    factoryContracts = contractsMap.test4;
    proxyFactoryAddresses = Object.keys(factoryContracts).reduce(
      (acc, key) => {
        acc[key] =
          contractsMap[origin][key as keyof ProxyFactoryFactories].address;
        return acc;
      },
      {} as Record<string, Address>,
    ) as HyperlaneAddresses<ProxyFactoryFactories>;
    arbBridge = await multiProvider.handleDeploy(
      origin,
      new MockArbBridge__factory(),
      [],
    );
    hookConfig.test4.bridge = arbBridge.address;

    const hookModule = await EvmHookModule.create({
      chain: origin,
      config: hookConfig.test4,
      proxyFactoryFactories: proxyFactoryAddresses,
      coreAddresses: core.getAddresses(origin),
      multiProvider,
    });
    const hookAddress = hookModule.serialize().deployedHook;

    arbL2ToL1Hook = ArbL2ToL1Hook__factory.connect(hookAddress, relayer);

    metadataBuilder = new ArbL2ToL1MetadataBuilder(core);
  });

  describe('#build', () => {
    let metadata: string;

    beforeEach(async () => {
      const testRecipient = testRecipients[destination];
      arbL2ToL1Ism = ArbL2ToL1Ism__factory.connect(
        bytes32ToAddress(await arbL2ToL1Hook.ism()),
        relayer,
      );
      await testRecipient.setInterchainSecurityModule(arbL2ToL1Ism.address);

      const { dispatchTx, message } = await core.sendMessage(
        origin,
        destination,
        testRecipient.address,
        '0xdeadbeef',
        arbL2ToL1Hook.address,
      );

      const derivedIsm = await new EvmIsmReader(
        core.multiProvider,
        destination,
      ).deriveIsmConfig(arbL2ToL1Ism.address);

      context = {
        hook: { ...hookConfig[origin], address: arbL2ToL1Hook.address },
        ism: derivedIsm as WithAddress<ArbL2ToL1IsmConfig>,
        message,
        dispatchTx,
      };

      sinon
        .stub(metadataBuilder, 'getArbitrumOutboxProof')
        .callsFake(async (): Promise<string[]> => {
          await arbBridge.setL2ToL1Sender(arbL2ToL1Hook.address);
          return [];
        });
    });

    it(`should build valid metadata using direct executeTransaction call`, async () => {
      setArbitrumBridgeStatus(ChildToParentMessageStatus.CONFIRMED);
      metadata = await metadataBuilder.build(context);

      await arbL2ToL1Ism.verify(metadata, context.message.message);
    });

    it(`should throw an error if the message has already been relayed`, async () => {
      setArbitrumBridgeStatus(ChildToParentMessageStatus.EXECUTED);

      try {
        await metadataBuilder.build(context);
        expect.fail('Expected an error to be thrown');
      } catch (error: any) {
        expect(error.message).to.include(
          'Arbitrum L2ToL1 message has already been executed',
        );
      }
      await expect(
        arbL2ToL1Ism.verify(metadata, context.message.message),
      ).to.be.revertedWith('ArbL2ToL1Ism: invalid message id');
    });

    it(`should throw an error if the challenge period hasn't passed`, async () => {
      setArbitrumBridgeStatus(ChildToParentMessageStatus.UNCONFIRMED);

      // stub waiting period to 10 blocks
      sinon
        .stub(metadataBuilder, 'getWaitingBlocksUntilReady')
        .callsFake(async (): Promise<BigNumber> => {
          return BigNumber.from(10); // test waiting period
        });

      try {
        await metadataBuilder.build(context);
        expect.fail('Expected an error to be thrown');
      } catch (error: any) {
        expect(error.message).to.include(
          "Arbitrum L2ToL1 message isn't ready for relay. Wait 10 blocks until the challenge period before relaying again",
        );
      }
      await expect(
        arbL2ToL1Ism.verify(metadata, context.message.message),
      ).to.be.revertedWith('ArbL2ToL1Ism: invalid message id');
    });

    it(`should build valid metadata if already preverified by 3rd party relayer`, async () => {
      setArbitrumBridgeStatus(ChildToParentMessageStatus.CONFIRMED);

      const calldata =
        await metadataBuilder.buildArbitrumBridgeCalldata(context);
      metadata = ArbL2ToL1MetadataBuilder.encodeArbL2ToL1Metadata(calldata);
      await arbBridge.executeTransaction(
        calldata.proof,
        calldata.position,
        calldata.caller,
        calldata.destination,
        calldata.arbBlockNum,
        calldata.ethBlockNum,
        calldata.timestamp,
        BigNumber.from(0), // msg.value
        calldata.data,
      );
      metadata = await metadataBuilder.build(context);
      await arbL2ToL1Ism.verify(metadata, context.message.message);
    });

    it(`should decode metadata`, async () => {
      setArbitrumBridgeStatus(ChildToParentMessageStatus.CONFIRMED);
      metadata = await metadataBuilder.build(context);

      ArbL2ToL1MetadataBuilder.decode(metadata, context);
    });
  });

  afterEach(() => {
    sinon.restore();
  });
});
