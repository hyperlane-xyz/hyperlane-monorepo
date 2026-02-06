import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  type ArtifactDeployed,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedMailboxAddress,
  type MailboxOnChain,
} from '@hyperlane-xyz/provider-sdk/mailbox';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { assert } from '@hyperlane-xyz/utils';

import { type CosmosNativeSigner } from '../clients/signer.js';
import { CosmosHookArtifactManager } from '../hook/hook-artifact-manager.js';
import { CosmosIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import { CosmosMailboxArtifactManager } from '../mailbox/mailbox-artifact-manager.js';
import { COSMOS_MODULE_MESSAGE_REGISTRY as MessageRegistry } from '../registry.js';
import { createSigner } from '../testing/utils.js';

chai.use(chaiAsPromised);

describe('Cosmos Mailbox Artifact API (e2e)', function () {
  this.timeout(100_000);

  let signer: AltVM.ISigner<AnnotatedTx, TxReceipt>;
  let cosmosSigner: CosmosNativeSigner;
  let mailboxArtifactManager: CosmosMailboxArtifactManager;
  let ismArtifactManager: CosmosIsmArtifactManager;
  let hookArtifactManager: CosmosHookArtifactManager;
  const domainId = 1234;
  const denom = 'uhyp';

  before(async () => {
    signer = await createSigner('alice');
    cosmosSigner = signer as CosmosNativeSigner;

    const [rpc, ...otherRpcUrls] = cosmosSigner.getRpcUrls();
    assert(rpc, 'At least one rpc is required');

    mailboxArtifactManager = new CosmosMailboxArtifactManager({
      rpcUrls: [rpc, ...otherRpcUrls],
      domainId,
    });

    ismArtifactManager = new CosmosIsmArtifactManager([rpc, ...otherRpcUrls]);

    // Create temp mailbox for hook manager
    const ismWriter = ismArtifactManager.createWriter(
      AltVM.IsmType.TEST_ISM,
      cosmosSigner,
    );
    const [tempIsm] = await ismWriter.create({
      config: { type: AltVM.IsmType.TEST_ISM },
    });

    const tempMailboxWriter = mailboxArtifactManager.createWriter(
      'mailbox',
      cosmosSigner,
    );
    const [tempMailbox] = await tempMailboxWriter.create({
      config: {
        owner: cosmosSigner.getSignerAddress(),
        defaultIsm: tempIsm,
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '' },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '' },
        },
      },
    });

    hookArtifactManager = new CosmosHookArtifactManager({
      rpcUrls: [rpc, ...otherRpcUrls],
      mailboxAddress: tempMailbox.deployed.address,
      nativeTokenDenom: denom,
    });
  });

  describe('Mailbox Creation', () => {
    it('should create a mailbox with all hooks and ISM', async () => {
      const ismWriter = ismArtifactManager.createWriter(
        AltVM.IsmType.TEST_ISM,
        cosmosSigner,
      );
      const [ism] = await ismWriter.create({
        config: { type: AltVM.IsmType.TEST_ISM },
      });

      const merkleTreeHookWriter = hookArtifactManager.createWriter(
        AltVM.HookType.MERKLE_TREE,
        cosmosSigner,
      );
      const [defaultHook] = await merkleTreeHookWriter.create({
        config: { type: AltVM.HookType.MERKLE_TREE },
      });

      const merkleTreeHookWriter2 = hookArtifactManager.createWriter(
        AltVM.HookType.MERKLE_TREE,
        cosmosSigner,
      );
      const [requiredHook] = await merkleTreeHookWriter2.create({
        config: { type: AltVM.HookType.MERKLE_TREE },
      });

      const config: MailboxOnChain = {
        owner: cosmosSigner.getSignerAddress(),
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ism.deployed.address },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: defaultHook.deployed.address },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: requiredHook.deployed.address },
        },
      };

      const writer = mailboxArtifactManager.createWriter(
        'mailbox',
        cosmosSigner,
      );
      const [result, receipts] = await writer.create({ config });

      expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(result.deployed.address).to.be.a('string').and.not.be.empty;
      expect(result.deployed.domainId).to.equal(domainId);
      expect(receipts).to.be.an('array').with.length.greaterThan(0);
      receipts.forEach((receipt) => {
        expect(receipt.code).to.equal(0);
      });

      const reader = mailboxArtifactManager.createReader('mailbox');
      const readMailbox = await reader.read(result.deployed.address);

      expect(readMailbox.config.owner).to.equal(
        cosmosSigner.getSignerAddress(),
      );
      expect(readMailbox.config.defaultIsm.deployed.address).to.equal(
        ism.deployed.address,
      );
      expect(readMailbox.config.defaultHook.deployed.address).to.equal(
        defaultHook.deployed.address,
      );
      expect(readMailbox.config.requiredHook.deployed.address).to.equal(
        requiredHook.deployed.address,
      );
    });

    it('should create a mailbox with minimal config (only ISM)', async () => {
      const ismWriter = ismArtifactManager.createWriter(
        AltVM.IsmType.TEST_ISM,
        cosmosSigner,
      );
      const [ism] = await ismWriter.create({
        config: { type: AltVM.IsmType.TEST_ISM },
      });

      const config: MailboxOnChain = {
        owner: cosmosSigner.getSignerAddress(),
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ism.deployed.address },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '' },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '' },
        },
      };

      const writer = mailboxArtifactManager.createWriter(
        'mailbox',
        cosmosSigner,
      );
      const [result, receipts] = await writer.create({ config });

      expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(result.deployed.address).to.be.a('string').and.not.be.empty;
      expect(receipts).to.be.an('array').with.length(1);
      receipts.forEach((receipt) => {
        expect(receipt.code).to.equal(0);
      });
    });

    it('should NOT transfer ownership during creation', async () => {
      const ismWriter = ismArtifactManager.createWriter(
        AltVM.IsmType.TEST_ISM,
        cosmosSigner,
      );
      const [ism] = await ismWriter.create({
        config: { type: AltVM.IsmType.TEST_ISM },
      });

      const bobSigner = await createSigner('bob');
      const bobAddress = bobSigner.getSignerAddress();
      const aliceAddress = cosmosSigner.getSignerAddress();

      const config: MailboxOnChain = {
        owner: bobAddress,
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ism.deployed.address },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '' },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '' },
        },
      };

      const writer = mailboxArtifactManager.createWriter(
        'mailbox',
        cosmosSigner,
      );
      const [result, receipts] = await writer.create({ config });

      expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(receipts).to.be.an('array').with.length(1);

      const reader = mailboxArtifactManager.createReader('mailbox');
      const readMailbox = await reader.read(result.deployed.address);

      expect(readMailbox.config.owner).to.equal(aliceAddress);
      expect(readMailbox.config.owner).to.not.equal(bobAddress);
    });
  });

  describe('Mailbox Reading', () => {
    it('should read a deployed mailbox', async () => {
      const ismWriter = ismArtifactManager.createWriter(
        AltVM.IsmType.TEST_ISM,
        cosmosSigner,
      );
      const [ism] = await ismWriter.create({
        config: { type: AltVM.IsmType.TEST_ISM },
      });

      const config: MailboxOnChain = {
        owner: cosmosSigner.getSignerAddress(),
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ism.deployed.address },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '' },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '' },
        },
      };

      const writer = mailboxArtifactManager.createWriter(
        'mailbox',
        cosmosSigner,
      );
      const [deployedMailbox] = await writer.create({ config });

      const reader = mailboxArtifactManager.createReader('mailbox');
      const readMailbox = await reader.read(deployedMailbox.deployed.address);

      expect(readMailbox.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readMailbox.deployed.address).to.equal(
        deployedMailbox.deployed.address,
      );
      expect(readMailbox.deployed.domainId).to.equal(domainId);
      expect(readMailbox.config.owner).to.equal(config.owner);
      expect(readMailbox.config.defaultIsm.deployed.address).to.equal(
        ism.deployed.address,
      );
    });

    it('should read mailbox via readMailbox method', async () => {
      const ismWriter = ismArtifactManager.createWriter(
        AltVM.IsmType.TEST_ISM,
        cosmosSigner,
      );
      const [ism] = await ismWriter.create({
        config: { type: AltVM.IsmType.TEST_ISM },
      });

      const config: MailboxOnChain = {
        owner: cosmosSigner.getSignerAddress(),
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ism.deployed.address },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '' },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '' },
        },
      };

      const writer = mailboxArtifactManager.createWriter(
        'mailbox',
        cosmosSigner,
      );
      const [deployedMailbox] = await writer.create({ config });

      const readMailbox = await mailboxArtifactManager.readMailbox(
        deployedMailbox.deployed.address,
      );

      expect(readMailbox.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readMailbox.deployed.address).to.equal(
        deployedMailbox.deployed.address,
      );
      expect(readMailbox.config.owner).to.equal(config.owner);
    });
  });

  describe('Mailbox Updates', () => {
    let deployedMailbox: ArtifactDeployed<
      MailboxOnChain,
      DeployedMailboxAddress
    >;
    let writer: ArtifactWriter<MailboxOnChain, DeployedMailboxAddress>;

    beforeEach(async () => {
      const ismWriter = ismArtifactManager.createWriter(
        AltVM.IsmType.TEST_ISM,
        cosmosSigner,
      );
      const [ism] = await ismWriter.create({
        config: { type: AltVM.IsmType.TEST_ISM },
      });

      const hookWriter = hookArtifactManager.createWriter(
        AltVM.HookType.MERKLE_TREE,
        cosmosSigner,
      );
      const [hook] = await hookWriter.create({
        config: { type: AltVM.HookType.MERKLE_TREE },
      });

      const config: MailboxOnChain = {
        owner: cosmosSigner.getSignerAddress(),
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ism.deployed.address },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: hook.deployed.address },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: '' },
        },
      };

      writer = mailboxArtifactManager.createWriter('mailbox', cosmosSigner);
      [deployedMailbox] = await writer.create({ config });
    });

    const updateTestCases: Array<{
      name: string;
      setupNewValue: () => Promise<string>;
      updateConfig: (
        mailbox: ArtifactDeployed<MailboxOnChain, DeployedMailboxAddress>,
        newValue: string,
      ) => ArtifactDeployed<MailboxOnChain, DeployedMailboxAddress>;
      verifyUpdate: (
        readMailbox: ArtifactDeployed<MailboxOnChain, DeployedMailboxAddress>,
        newValue: string,
      ) => void;
    }> = [
      {
        name: 'default ISM',
        setupNewValue: async () => {
          const ismWriter = ismArtifactManager.createWriter(
            AltVM.IsmType.TEST_ISM,
            cosmosSigner,
          );
          const [newIsm] = await ismWriter.create({
            config: { type: AltVM.IsmType.TEST_ISM },
          });
          return newIsm.deployed.address;
        },
        updateConfig: (mailbox, newValue) => ({
          ...mailbox,
          config: {
            ...mailbox.config,
            defaultIsm: {
              artifactState: ArtifactState.UNDERIVED,
              deployed: { address: newValue },
            },
          },
        }),
        verifyUpdate: (readMailbox, newValue) => {
          expect(readMailbox.config.defaultIsm.deployed.address).to.equal(
            newValue,
          );
        },
      },
      {
        name: 'default hook',
        setupNewValue: async () => {
          const hookWriter = hookArtifactManager.createWriter(
            AltVM.HookType.MERKLE_TREE,
            cosmosSigner,
          );
          const [newHook] = await hookWriter.create({
            config: { type: AltVM.HookType.MERKLE_TREE },
          });
          return newHook.deployed.address;
        },
        updateConfig: (mailbox, newValue) => ({
          ...mailbox,
          config: {
            ...mailbox.config,
            defaultHook: {
              artifactState: ArtifactState.UNDERIVED,
              deployed: { address: newValue },
            },
          },
        }),
        verifyUpdate: (readMailbox, newValue) => {
          expect(readMailbox.config.defaultHook.deployed.address).to.equal(
            newValue,
          );
        },
      },
      {
        name: 'required hook',
        setupNewValue: async () => {
          const hookWriter = hookArtifactManager.createWriter(
            AltVM.HookType.MERKLE_TREE,
            cosmosSigner,
          );
          const [newHook] = await hookWriter.create({
            config: { type: AltVM.HookType.MERKLE_TREE },
          });
          return newHook.deployed.address;
        },
        updateConfig: (mailbox, newValue) => ({
          ...mailbox,
          config: {
            ...mailbox.config,
            requiredHook: {
              artifactState: ArtifactState.UNDERIVED,
              deployed: { address: newValue },
            },
          },
        }),
        verifyUpdate: (readMailbox, newValue) => {
          expect(readMailbox.config.requiredHook.deployed.address).to.equal(
            newValue,
          );
        },
      },
      {
        name: 'owner',
        setupNewValue: async () => {
          const bobSigner = await createSigner('bob');
          return bobSigner.getSignerAddress();
        },
        updateConfig: (mailbox, newValue) => ({
          ...mailbox,
          config: {
            ...mailbox.config,
            owner: newValue,
          },
        }),
        verifyUpdate: (readMailbox, newValue) => {
          expect(readMailbox.config.owner).to.equal(newValue);
        },
      },
    ];

    updateTestCases.forEach(
      ({ name, setupNewValue, updateConfig, verifyUpdate }) => {
        it(`should update ${name}`, async () => {
          const newValue = await setupNewValue();
          const updatedConfig = updateConfig(deployedMailbox, newValue);

          const txs = await writer.update(updatedConfig);

          expect(txs).to.be.an('array').with.length(1);
          expect(txs[0].typeUrl).to.equal(
            MessageRegistry.MsgSetMailbox.proto.type,
          );

          const receipt = await signer.sendAndConfirmTransaction(txs[0]);
          expect(receipt.code).to.equal(0);

          const reader = mailboxArtifactManager.createReader('mailbox');
          const readMailbox = await reader.read(
            deployedMailbox.deployed.address,
          );
          verifyUpdate(readMailbox, newValue);
        });
      },
    );

    it('should return no transactions when no updates needed', async () => {
      const txs = await writer.update(deployedMailbox);
      expect(txs).to.be.an('array').with.length(0);
    });
  });
});
