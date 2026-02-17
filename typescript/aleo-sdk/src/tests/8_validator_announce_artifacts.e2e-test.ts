import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { eqAddressAleo } from '@hyperlane-xyz/utils';

import { type AnyAleoNetworkClient } from '../clients/base.js';
import { AleoSigner } from '../clients/signer.js';
import { AleoIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import { AleoMailboxArtifactManager } from '../mailbox/mailbox-artifact-manager.js';
import {
  TEST_ALEO_CHAIN_METADATA,
  TEST_ALEO_PRIVATE_KEY,
} from '../testing/constants.js';
import { ALEO_NULL_ADDRESS, fromAleoAddress } from '../utils/helper.js';
import { AleoNetworkId } from '../utils/types.js';
import { AleoValidatorAnnounceArtifactManager } from '../validator-announce/validator-announce-artifact-manager.js';

chai.use(chaiAsPromised);

describe('8. aleo sdk ValidatorAnnounce artifacts e2e tests', async function () {
  this.timeout(100_000);

  let signer: AltVM.ISigner<AnnotatedTx, TxReceipt>;
  let aleoSigner: AleoSigner;
  let aleoClient: AnyAleoNetworkClient;
  let validatorAnnounceArtifactManager: AleoValidatorAnnounceArtifactManager;
  let mailboxArtifactManager: AleoMailboxArtifactManager;
  let ismArtifactManager: AleoIsmArtifactManager;
  let testMailboxAddress: string;
  const domainId = 1234;

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

    validatorAnnounceArtifactManager = new AleoValidatorAnnounceArtifactManager(
      AleoNetworkId.TESTNET,
      aleoClient,
    );
    mailboxArtifactManager = new AleoMailboxArtifactManager(
      {
        domainId,
        aleoNetworkId: AleoNetworkId.TESTNET,
      },
      aleoClient,
    );
    ismArtifactManager = new AleoIsmArtifactManager(aleoClient);

    // Create a fresh mailbox for test isolation
    const ismWriter = ismArtifactManager.createWriter(
      AltVM.IsmType.TEST_ISM,
      aleoSigner,
    );
    const [ism] = await ismWriter.create({
      config: { type: AltVM.IsmType.TEST_ISM },
    });

    const mailboxWriter = mailboxArtifactManager.createWriter(
      'mailbox',
      aleoSigner,
    );
    const [deployedMailbox] = await mailboxWriter.create({
      config: {
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
      },
    });

    testMailboxAddress = deployedMailbox.deployed.address;
  });

  it('should create validator announce contract', async () => {
    const writer = validatorAnnounceArtifactManager.createWriter(
      'validatorAnnounce',
      aleoSigner,
    );

    const [result, receipts] = await writer.create({
      config: {
        mailboxAddress: testMailboxAddress,
      },
    });

    expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
    expect(result.deployed.address).to.be.a('string').and.not.be.empty;
    expect(result.config.mailboxAddress).to.equal(testMailboxAddress);
    expect(receipts).to.be.an('array').with.length(1); // init transaction
    receipts.forEach((receipt) => {
      expect(receipt.transactionHash).to.not.be.empty;
    });
  });

  it('should read validator announce config from chain', async () => {
    const writer = validatorAnnounceArtifactManager.createWriter(
      'validatorAnnounce',
      aleoSigner,
    );

    const [deployed] = await writer.create({
      config: {
        mailboxAddress: testMailboxAddress,
      },
    });

    const reader =
      validatorAnnounceArtifactManager.createReader('validatorAnnounce');
    const readResult = await reader.read(deployed.deployed.address);

    expect(readResult.artifactState).to.equal(ArtifactState.DEPLOYED);
    expect(readResult.deployed.address).to.equal(deployed.deployed.address);
    const { address: testMailboxPlainAddress } =
      fromAleoAddress(testMailboxAddress);
    expect(
      eqAddressAleo(readResult.config.mailboxAddress, testMailboxPlainAddress),
    ).to.be.true;
  });

  it('should return no transactions when calling update (immutable)', async () => {
    const writer = validatorAnnounceArtifactManager.createWriter(
      'validatorAnnounce',
      aleoSigner,
    );

    const [deployed] = await writer.create({
      config: {
        mailboxAddress: testMailboxAddress,
      },
    });

    const updateTxs = await writer.update(deployed);

    expect(updateTxs).to.be.an('array').with.length(0);
  });

  it('should use readValidatorAnnounce convenience method', async () => {
    const writer = validatorAnnounceArtifactManager.createWriter(
      'validatorAnnounce',
      aleoSigner,
    );

    const [deployed] = await writer.create({
      config: {
        mailboxAddress: testMailboxAddress,
      },
    });

    const readResult =
      await validatorAnnounceArtifactManager.readValidatorAnnounce(
        deployed.deployed.address,
      );

    expect(readResult.artifactState).to.equal(ArtifactState.DEPLOYED);
    expect(readResult.deployed.address).to.equal(deployed.deployed.address);
    const { address: testMailboxPlainAddress } =
      fromAleoAddress(testMailboxAddress);
    expect(
      eqAddressAleo(readResult.config.mailboxAddress, testMailboxPlainAddress),
    ).to.be.true;
  });

  it('should create multiple instances with same mailbox', async () => {
    const writer = validatorAnnounceArtifactManager.createWriter(
      'validatorAnnounce',
      aleoSigner,
    );

    const [instance1] = await writer.create({
      config: {
        mailboxAddress: testMailboxAddress,
      },
    });

    const [instance2] = await writer.create({
      config: {
        mailboxAddress: testMailboxAddress,
      },
    });

    expect(instance1.deployed.address).to.not.equal(instance2.deployed.address);
    expect(instance1.artifactState).to.equal(ArtifactState.DEPLOYED);
    expect(instance2.artifactState).to.equal(ArtifactState.DEPLOYED);

    // Verify both instances have the same mailbox address
    const reader =
      validatorAnnounceArtifactManager.createReader('validatorAnnounce');
    const read1 = await reader.read(instance1.deployed.address);
    const read2 = await reader.read(instance2.deployed.address);

    const { address: testMailboxPlainAddress } =
      fromAleoAddress(testMailboxAddress);
    expect(eqAddressAleo(read1.config.mailboxAddress, testMailboxPlainAddress))
      .to.be.true;
    expect(eqAddressAleo(read2.config.mailboxAddress, testMailboxPlainAddress))
      .to.be.true;
  });
});
