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
import { eqAddressAleo } from '@hyperlane-xyz/utils';

import { type AnyAleoNetworkClient } from '../clients/base.js';
import { AleoSigner } from '../clients/signer.js';
import { AleoHookArtifactManager } from '../hook/hook-artifact-manager.js';
import { AleoIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import { AleoMailboxArtifactManager } from '../mailbox/mailbox-artifact-manager.js';
import {
  TEST_ALEO_CHAIN_METADATA,
  TEST_ALEO_PRIVATE_KEY,
} from '../testing/constants.js';
import { ALEO_NULL_ADDRESS } from '../utils/helper.js';
import { AleoNetworkId } from '../utils/types.js';

chai.use(chaiAsPromised);

describe('7. aleo sdk Mailbox artifacts e2e tests', async function () {
  this.timeout(100_000);

  let signer: AltVM.ISigner<AnnotatedTx, TxReceipt>;
  let aleoSigner: AleoSigner;
  let aleoClient: AnyAleoNetworkClient;
  let mailboxArtifactManager: AleoMailboxArtifactManager;
  let ismArtifactManager: AleoIsmArtifactManager;
  const domainId = 1234;

  // Test address for ownership transfers (derived from a different private key)
  // This is the address from APrivateKey1zkp2RWGDcde3efRZzZPFPr3tRN6R7qCCVbLvZDJZuJ5VrBS
  const TEST_OWNER_ADDRESS =
    'aleo1d5hg2z3ma00382pngntdp68e74zv54jdxy249qhaujhks9c72yrs33ddah';

  before(async () => {
    signer = await AleoSigner.connectWithSigner(
      [TEST_ALEO_CHAIN_METADATA.rpcUrl],
      TEST_ALEO_PRIVATE_KEY,
      {
        metadata: {
          chainId: 1,
          domainId,
        },
      },
    );

    aleoSigner = signer as AleoSigner;
    aleoClient = (aleoSigner as any).aleoClient;

    mailboxArtifactManager = new AleoMailboxArtifactManager(
      {
        domainId,
        aleoNetworkId: AleoNetworkId.TESTNET,
      },
      aleoClient,
    );
    ismArtifactManager = new AleoIsmArtifactManager(aleoClient);
  });

  describe('Mailbox Creation', () => {
    it('should create a mailbox with all hooks and ISM', async () => {
      // Step 1: Create ISM first
      const ismWriter = ismArtifactManager.createWriter(
        AltVM.IsmType.TEST_ISM,
        aleoSigner,
      );
      const [ism] = await ismWriter.create({
        config: { type: AltVM.IsmType.TEST_ISM },
      });

      // Step 2: Create mailbox with ISM but null hooks
      const initialConfig: MailboxOnChain = {
        owner: aleoSigner.getSignerAddress(),
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ism.deployed.address },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ALEO_NULL_ADDRESS },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ALEO_NULL_ADDRESS },
        },
      };

      const writer = mailboxArtifactManager.createWriter('mailbox', aleoSigner);
      const [result, createReceipts] = await writer.create({
        config: initialConfig,
      });

      expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(result.deployed.address).to.be.a('string').and.not.be.empty;
      expect(result.deployed.domainId).to.equal(domainId);
      expect(createReceipts).to.be.an('array').with.length.greaterThan(0);

      // Step 3: Create hooks with the mailbox context
      const hookArtifactManager = new AleoHookArtifactManager(
        aleoClient,
        result.deployed.address,
      );

      const merkleTreeHookWriter = hookArtifactManager.createWriter(
        AltVM.HookType.MERKLE_TREE,
        aleoSigner,
      );
      const [defaultHook] = await merkleTreeHookWriter.create({
        config: { type: AltVM.HookType.MERKLE_TREE },
      });

      const merkleTreeHookWriter2 = hookArtifactManager.createWriter(
        AltVM.HookType.MERKLE_TREE,
        aleoSigner,
      );
      const [requiredHook] = await merkleTreeHookWriter2.create({
        config: { type: AltVM.HookType.MERKLE_TREE },
      });

      // Step 4: Update mailbox to set hooks
      const updatedConfig: MailboxOnChain = {
        ...initialConfig,
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: defaultHook.deployed.address },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: requiredHook.deployed.address },
        },
      };

      const updateTxs = await writer.update({
        ...result,
        config: updatedConfig,
      });

      expect(updateTxs).to.be.an('array').with.length(2); // 2 hooks to set
      for (const tx of updateTxs) {
        const receipt = await signer.sendAndConfirmTransaction(tx);
        expect(receipt.transactionHash).to.not.be.empty;
      }

      // Step 5: Verify final configuration
      const reader = mailboxArtifactManager.createReader('mailbox');
      const readMailbox = await reader.read(result.deployed.address);

      expect(
        eqAddressAleo(readMailbox.config.owner, aleoSigner.getSignerAddress()),
      ).to.be.true;
      expect(
        eqAddressAleo(
          readMailbox.config.defaultIsm.deployed.address,
          ism.deployed.address,
        ),
      ).to.be.true;
      expect(
        eqAddressAleo(
          readMailbox.config.defaultHook.deployed.address,
          defaultHook.deployed.address,
        ),
      ).to.be.true;
      expect(
        eqAddressAleo(
          readMailbox.config.requiredHook.deployed.address,
          requiredHook.deployed.address,
        ),
      ).to.be.true;
    });

    it('should create a mailbox with minimal config (only ISM)', async () => {
      const ismWriter = ismArtifactManager.createWriter(
        AltVM.IsmType.TEST_ISM,
        aleoSigner,
      );
      const [ism] = await ismWriter.create({
        config: { type: AltVM.IsmType.TEST_ISM },
      });

      const config: MailboxOnChain = {
        owner: aleoSigner.getSignerAddress(),
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ism.deployed.address },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ALEO_NULL_ADDRESS },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ALEO_NULL_ADDRESS },
        },
      };

      const writer = mailboxArtifactManager.createWriter('mailbox', aleoSigner);
      const [result, receipts] = await writer.create({ config });

      expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(result.deployed.address).to.be.a('string').and.not.be.empty;
      // For Aleo, we expect: create + set_dispatch_proxy + set_default_ism = 3 receipts minimum
      expect(receipts).to.be.an('array').with.length.greaterThan(2);
      receipts.forEach((receipt) => {
        expect(receipt.transactionHash).to.not.be.empty;
      });
    });

    it('should NOT transfer ownership during creation', async () => {
      const ismWriter = ismArtifactManager.createWriter(
        AltVM.IsmType.TEST_ISM,
        aleoSigner,
      );
      const [ism] = await ismWriter.create({
        config: { type: AltVM.IsmType.TEST_ISM },
      });

      const aliceAddress = aleoSigner.getSignerAddress();

      // Create mailbox with TEST_OWNER_ADDRESS in config
      // But ownership should NOT be transferred during creation
      const config: MailboxOnChain = {
        owner: TEST_OWNER_ADDRESS,
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ism.deployed.address },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ALEO_NULL_ADDRESS },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ALEO_NULL_ADDRESS },
        },
      };

      const writer = mailboxArtifactManager.createWriter('mailbox', aleoSigner);
      const [result, receipts] = await writer.create({ config });

      expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(receipts).to.be.an('array');

      const reader = mailboxArtifactManager.createReader('mailbox');
      const readMailbox = await reader.read(result.deployed.address);

      // Owner should still be the signer, NOT the configured owner
      expect(eqAddressAleo(readMailbox.config.owner, aliceAddress)).to.be.true;
      expect(eqAddressAleo(readMailbox.config.owner, TEST_OWNER_ADDRESS)).to.be
        .false;
    });
  });

  describe('Mailbox Reading', () => {
    it('should read a deployed mailbox', async () => {
      const ismWriter = ismArtifactManager.createWriter(
        AltVM.IsmType.TEST_ISM,
        aleoSigner,
      );
      const [ism] = await ismWriter.create({
        config: { type: AltVM.IsmType.TEST_ISM },
      });

      const config: MailboxOnChain = {
        owner: aleoSigner.getSignerAddress(),
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ism.deployed.address },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ALEO_NULL_ADDRESS },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ALEO_NULL_ADDRESS },
        },
      };

      const writer = mailboxArtifactManager.createWriter('mailbox', aleoSigner);
      const [deployedMailbox] = await writer.create({ config });

      const reader = mailboxArtifactManager.createReader('mailbox');
      const readMailbox = await reader.read(deployedMailbox.deployed.address);

      expect(readMailbox.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readMailbox.deployed.address).to.equal(
        deployedMailbox.deployed.address,
      );
      expect(readMailbox.deployed.domainId).to.equal(domainId);
      expect(eqAddressAleo(readMailbox.config.owner, config.owner)).to.be.true;
      expect(
        eqAddressAleo(
          readMailbox.config.defaultIsm.deployed.address,
          ism.deployed.address,
        ),
      ).to.be.true;
    });

    it('should read mailbox via readMailbox method', async () => {
      const ismWriter = ismArtifactManager.createWriter(
        AltVM.IsmType.TEST_ISM,
        aleoSigner,
      );
      const [ism] = await ismWriter.create({
        config: { type: AltVM.IsmType.TEST_ISM },
      });

      const config: MailboxOnChain = {
        owner: aleoSigner.getSignerAddress(),
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ism.deployed.address },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ALEO_NULL_ADDRESS },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ALEO_NULL_ADDRESS },
        },
      };

      const writer = mailboxArtifactManager.createWriter('mailbox', aleoSigner);
      const [deployedMailbox] = await writer.create({ config });

      const readMailbox = await mailboxArtifactManager.readMailbox(
        deployedMailbox.deployed.address,
      );

      expect(readMailbox.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readMailbox.deployed.address).to.equal(
        deployedMailbox.deployed.address,
      );
      expect(eqAddressAleo(readMailbox.config.owner, config.owner)).to.be.true;
    });
  });

  describe('Mailbox Updates', () => {
    let deployedMailbox: ArtifactDeployed<
      MailboxOnChain,
      DeployedMailboxAddress
    >;
    let writer: ArtifactWriter<MailboxOnChain, DeployedMailboxAddress>;

    beforeEach(async () => {
      // Step 1: Create ISM
      const ismWriter = ismArtifactManager.createWriter(
        AltVM.IsmType.TEST_ISM,
        aleoSigner,
      );
      const [ism] = await ismWriter.create({
        config: { type: AltVM.IsmType.TEST_ISM },
      });

      // Step 2: Create mailbox with ISM but null hooks
      const initialConfig: MailboxOnChain = {
        owner: aleoSigner.getSignerAddress(),
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ism.deployed.address },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ALEO_NULL_ADDRESS },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ALEO_NULL_ADDRESS },
        },
      };

      writer = mailboxArtifactManager.createWriter('mailbox', aleoSigner);
      [deployedMailbox] = await writer.create({ config: initialConfig });

      // Step 3: Create hook with the mailbox context
      const hookArtifactManager = new AleoHookArtifactManager(
        aleoClient,
        deployedMailbox.deployed.address,
      );

      const hookWriter = hookArtifactManager.createWriter(
        AltVM.HookType.MERKLE_TREE,
        aleoSigner,
      );
      const [hook] = await hookWriter.create({
        config: { type: AltVM.HookType.MERKLE_TREE },
      });

      // Step 4: Update mailbox to set default hook
      const updatedConfig: MailboxOnChain = {
        ...initialConfig,
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: hook.deployed.address },
        },
      };

      const updateTxs = await writer.update({
        ...deployedMailbox,
        config: updatedConfig,
      });

      for (const tx of updateTxs) {
        await signer.sendAndConfirmTransaction(tx);
      }

      // Update deployedMailbox to reflect the new config
      deployedMailbox = {
        ...deployedMailbox,
        config: updatedConfig,
      };
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
            aleoSigner,
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
          expect(
            eqAddressAleo(
              readMailbox.config.defaultIsm.deployed.address,
              newValue,
            ),
          ).to.be.true;
        },
      },
      {
        name: 'default hook',
        setupNewValue: async () => {
          const hookArtifactManager = new AleoHookArtifactManager(
            aleoClient,
            deployedMailbox.deployed.address,
          );
          const hookWriter = hookArtifactManager.createWriter(
            AltVM.HookType.MERKLE_TREE,
            aleoSigner,
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
          expect(
            eqAddressAleo(
              readMailbox.config.defaultHook.deployed.address,
              newValue,
            ),
          ).to.be.true;
        },
      },
      {
        name: 'required hook',
        setupNewValue: async () => {
          const hookArtifactManager = new AleoHookArtifactManager(
            aleoClient,
            deployedMailbox.deployed.address,
          );
          const hookWriter = hookArtifactManager.createWriter(
            AltVM.HookType.MERKLE_TREE,
            aleoSigner,
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
          expect(
            eqAddressAleo(
              readMailbox.config.requiredHook.deployed.address,
              newValue,
            ),
          ).to.be.true;
        },
      },
      {
        name: 'owner',
        setupNewValue: async () => {
          return ALEO_NULL_ADDRESS;
        },
        updateConfig: (mailbox, newValue) => ({
          ...mailbox,
          config: {
            ...mailbox.config,
            owner: newValue,
          },
        }),
        verifyUpdate: (readMailbox, newValue) => {
          expect(eqAddressAleo(readMailbox.config.owner, newValue)).to.be.true;
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
          expect(txs[0]).to.have.property('annotation');
          expect(txs[0]).to.have.property('programName');

          const receipt = await signer.sendAndConfirmTransaction(txs[0]);
          expect(receipt.transactionHash).to.not.be.empty;

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
