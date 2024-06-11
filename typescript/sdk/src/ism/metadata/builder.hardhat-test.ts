import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import hre from 'hardhat';
import { before } from 'mocha';
import sinon from 'sinon';

import { MerkleTreeHook, TestRecipient } from '@hyperlane-xyz/core';
import {
  BaseValidator,
  Checkpoint,
  CheckpointWithId,
  Domain,
  S3CheckpointWithId,
  addressToBytes32,
  eqAddress,
  objMap,
  randomElement,
} from '@hyperlane-xyz/utils';

import { testChains } from '../../consts/testChains.js';
import { serializeContractsMap } from '../../contracts/contracts.js';
import { HyperlaneCore } from '../../core/HyperlaneCore.js';
import { TestCoreDeployer } from '../../core/TestCoreDeployer.js';
import { TestRecipientDeployer } from '../../core/TestRecipientDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../../deploy/HyperlaneProxyFactoryDeployer.js';
import { HyperlaneHookDeployer } from '../../hook/HyperlaneHookDeployer.js';
import { HookType, MerkleTreeHookConfig } from '../../hook/types.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { ChainName } from '../../types.js';
import { EvmIsmReader } from '../EvmIsmReader.js';
import { randomIsmConfig } from '../HyperlaneIsmFactory.hardhat-test.js';
import { HyperlaneIsmFactory } from '../HyperlaneIsmFactory.js';

import { BaseMetadataBuilder, MetadataContext } from './builder.js';

const MAX_ISM_DEPTH = 5;
const MAX_NUM_VALIDATORS = 10;
const NUM_RUNS = 16;

describe('BaseMetadataBuilder', () => {
  let core: HyperlaneCore;
  let ismFactory: HyperlaneIsmFactory;
  let merkleHooks: Record<Domain, MerkleTreeHook>;
  let testRecipients: Record<ChainName, TestRecipient>;
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
    const recipientDeployer = new TestRecipientDeployer(multiProvider);
    testRecipients = objMap(
      await recipientDeployer.deploy(
        Object.fromEntries(testChains.map((c) => [c, {}])),
      ),
      (_, { testRecipient }) => testRecipient,
    );
    core = await coreDeployer.deployApp();
    const hookDeployer = new HyperlaneHookDeployer(
      multiProvider,
      serializeContractsMap(core.contractsMap),
      ismFactory,
    );
    const hookConfig = objMap(
      core.chainMap,
      (): MerkleTreeHookConfig => ({
        type: HookType.MERKLE_TREE,
      }),
    );
    const hookContracts = await hookDeployer.deploy(hookConfig);
    merkleHooks = Object.fromEntries(
      Object.entries(hookContracts).map(([chain, { merkleTreeHook }]) => [
        core.multiProvider.getDomainId(chain),
        merkleTreeHook,
      ]),
    );

    metadataBuilder = new BaseMetadataBuilder(core);

    sinon
      .stub(metadataBuilder.multisigMetadataBuilder, 'getS3Checkpoints')
      .callsFake(
        async (multisigAddresses, match): Promise<S3CheckpointWithId[]> => {
          const merkleHook = merkleHooks[match.origin];
          const checkpoint: Checkpoint = {
            root: await merkleHook.root(),
            merkle_tree_hook_address: addressToBytes32(merkleHook.address),
            index: match.index,
            mailbox_domain: match.origin,
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

  // eslint-disable-next-line jest/no-disabled-tests
  describe.skip('#build', () => {
    let origin: ChainName;
    let destination: ChainName;
    let context: MetadataContext;
    let metadata: string;

    beforeEach(async () => {
      origin = randomElement(testChains);
      destination = randomElement(testChains.filter((c) => c !== origin));
      const testRecipient = testRecipients[destination];

      const addresses = validators
        .map((s) => s.address)
        .slice(0, MAX_NUM_VALIDATORS);
      const config = randomIsmConfig(MAX_ISM_DEPTH, addresses, relayer.address);
      const deployedIsm = await ismFactory.deploy({
        destination,
        config,
        mailbox: core.getAddresses(destination).mailbox,
      });
      await testRecipient.setInterchainSecurityModule(deployedIsm.address);

      const merkleHookAddress =
        merkleHooks[core.multiProvider.getDomainId(origin)].address;
      const { dispatchTx, message } = await core.sendMessage(
        origin,
        destination,
        testRecipient.address,
        '0xdeadbeef',
        merkleHookAddress,
      );

      const derivedIsm = await new EvmIsmReader(
        core.multiProvider,
        destination,
      ).deriveIsmConfig(deployedIsm.address);

      context = {
        hook: {
          type: HookType.MERKLE_TREE,
          address: merkleHookAddress,
        },
        ism: derivedIsm,
        message,
        dispatchTx,
      };

      metadata = await metadataBuilder.build(context, MAX_ISM_DEPTH);
    });

    for (let i = 0; i < NUM_RUNS; i++) {
      it(`should build valid metadata for random ism config (${i})`, async () => {
        // must call process for trusted relayer to be able to verify
        await core
          .getContracts(destination)
          .mailbox.process(metadata, context.message.message);
      });

      it(`should decode metadata for random ism config (${i})`, async () => {
        BaseMetadataBuilder.decode(metadata, context);
      });
    }
  });
});
