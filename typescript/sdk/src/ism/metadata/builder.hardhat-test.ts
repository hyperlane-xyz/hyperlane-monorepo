import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import hre from 'hardhat';
import { before } from 'mocha';
import sinon from 'sinon';

import {
  BaseValidator,
  Checkpoint,
  CheckpointWithId,
  S3CheckpointWithId,
  addressToBytes32,
  eqAddress,
} from '@hyperlane-xyz/utils';

import { testChains } from '../../consts/testChains.js';
import { HyperlaneCore } from '../../core/HyperlaneCore.js';
import { TestCoreDeployer } from '../../core/TestCoreDeployer.js';
import { TestRecipientDeployer } from '../../core/TestRecipientDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../../deploy/HyperlaneProxyFactoryDeployer.js';
import { HyperlaneHookDeployer } from '../../hook/HyperlaneHookDeployer.js';
import { HookType } from '../../hook/types.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { EvmIsmReader } from '../EvmIsmReader.js';
import { randomIsmConfig } from '../HyperlaneIsmFactory.hardhat-test.js';
import { HyperlaneIsmFactory } from '../HyperlaneIsmFactory.js';
import { DeployedIsm } from '../types.js';

import { BaseMetadataBuilder, MetadataContext } from './builder.js';

const MAX_ISM_DEPTH = 5;
const MAX_NUM_VALIDATORS = 10;
const NUM_RUNS = 16;

describe('BaseMetadataBuilder', () => {
  const origin = testChains[0];
  const destination = testChains[1];

  let core: HyperlaneCore;
  let ismFactory: HyperlaneIsmFactory;
  let recipientDeployer: TestRecipientDeployer;
  let context: MetadataContext;
  let deployedIsm: DeployedIsm;
  let recipientAddress: string;
  let relayer: SignerWithAddress;
  let validators: SignerWithAddress[];

  let metadataBuilder: BaseMetadataBuilder;

  before(async () => {
    [relayer, ...validators] = await hre.ethers.getSigners();
    const multiProvider = MultiProvider.createTestMultiProvider({
      signer: relayer,
    });
    const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
    ismFactory = new HyperlaneIsmFactory(
      await ismFactoryDeployer.deploy(multiProvider.mapKnownChains(() => ({}))),
      multiProvider,
    );

    const coreDeployer = new TestCoreDeployer(multiProvider, ismFactory);
    recipientDeployer = new TestRecipientDeployer(multiProvider);
    core = await coreDeployer.deployApp();
    const hookDeployer = new HyperlaneHookDeployer(
      multiProvider,
      { [origin]: core.getAddresses(origin) },
      ismFactory,
    );
    const hookContracts = await hookDeployer.deployContracts(origin, {
      type: HookType.MERKLE_TREE,
    });
    const merkleTreeHook = hookContracts.merkleTreeHook;
    // @ts-ignore partial assignment
    context = {
      hook: {
        type: HookType.MERKLE_TREE,
        address: merkleTreeHook.address,
      },
    };

    metadataBuilder = new BaseMetadataBuilder(core);

    sinon
      .stub(metadataBuilder.multisigMetadataBuilder, 'getS3Checkpoints')
      .callsFake(
        async (multisigAddresses, match): Promise<S3CheckpointWithId[]> => {
          const checkpoint: Checkpoint = {
            root: await merkleTreeHook.root(),
            index: match.index,
            mailbox_domain: match.origin,
            merkle_tree_hook_address: addressToBytes32(context.hook.address),
          };
          const checkpointWithId: CheckpointWithId = {
            checkpoint,
            message_id: match.messageId,
          };
          const digest = BaseValidator.messageHash(checkpoint, match.messageId);
          const checkpoints: S3CheckpointWithId[] = [];
          for (const validator of multisigAddresses) {
            const signature = await validators
              .find((s) => eqAddress(s.address, validator))!
              .signMessage(digest);
            checkpoints.push({ value: checkpointWithId, signature });
          }
          return checkpoints;
        },
      );
  });

  describe('#build', () => {
    beforeEach(async () => {
      const validatorAddresses = validators
        .map((s) => s.address)
        .slice(0, MAX_NUM_VALIDATORS);
      const config = randomIsmConfig(
        MAX_ISM_DEPTH - 1, // function does depth + 1
        validatorAddresses,
        relayer.address,
      );
      deployedIsm = await ismFactory.deploy({
        destination,
        config,
        mailbox: core.getAddresses(destination).mailbox,
      });
      context.ism = await new EvmIsmReader(
        core.multiProvider,
        destination,
      ).deriveIsmConfig(deployedIsm.address);

      const contracts = await recipientDeployer.deployContracts(destination, {
        interchainSecurityModule: deployedIsm.address,
      });
      recipientAddress = contracts.testRecipient.address;

      context.dispatchTx = await core.send(
        origin,
        destination,
        recipientAddress,
        '0xdeadbeef',
        context.hook.address,
      );
      context.message = core.getDispatchedMessages(context.dispatchTx)[0];
    });

    for (let i = 0; i < NUM_RUNS; i++) {
      it(`should build valid metadata for random ism config (${i})`, async () => {
        const metadata = await metadataBuilder.build(context, MAX_ISM_DEPTH);
        try {
          const mailbox = core.getContracts(destination).mailbox;
          // must call process for trusted relayer to be able to verify
          await mailbox
            .connect(relayer)
            .process(metadata, context.message.message);
        } catch (e) {
          const decoded = BaseMetadataBuilder.decode(
            metadata,
            context.message.parsed,
            context.ism,
          );
          console.dir({ ism: context.ism, decoded }, { depth: 20 });
          throw e;
        }
      });
    }
  });
});
