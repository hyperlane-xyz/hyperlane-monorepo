import { expect } from 'chai';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { assert, eqAddressStarknet } from '@hyperlane-xyz/utils';

import { StarknetSigner } from '../clients/signer.js';
import { StarknetIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import { StarknetMailboxArtifactManager } from '../mailbox/mailbox-artifact-manager.js';
import {
  DEFAULT_E2E_TEST_TIMEOUT,
  TEST_STARKNET_CHAIN_METADATA,
} from '../testing/constants.js';
import { createSigner } from '../testing/utils.js';
import { StarknetValidatorAnnounceArtifactManager } from '../validator-announce/validator-announce-artifact-manager.js';

describe('4. starknet sdk validator announce e2e tests', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let signer: StarknetSigner;
  let mailboxAddress: string;
  let artifactManager: StarknetValidatorAnnounceArtifactManager;
  let ismArtifactManager: StarknetIsmArtifactManager;
  let mailboxArtifactManager: StarknetMailboxArtifactManager;

  before(async () => {
    signer = await createSigner();
    ismArtifactManager = new StarknetIsmArtifactManager(
      TEST_STARKNET_CHAIN_METADATA,
    );
    mailboxArtifactManager = new StarknetMailboxArtifactManager(
      TEST_STARKNET_CHAIN_METADATA,
    );

    const [ism] = await ismArtifactManager
      .createWriter(AltVM.IsmType.TEST_ISM, signer)
      .create({
        config: { type: AltVM.IsmType.TEST_ISM },
      });
    const hookTx = await signer.getCreateNoopHookTransaction({
      signer: signer.getSignerAddress(),
      mailboxAddress: '',
    });
    const hookReceipt = await signer.sendAndConfirmTransaction(hookTx);
    assert(hookReceipt.contractAddress, 'failed to deploy noop hook');
    const hookAddress = hookReceipt.contractAddress;

    const [mailbox] = await mailboxArtifactManager
      .createWriter('mailbox', signer)
      .create({
        config: {
          owner: signer.getSignerAddress(),
          defaultIsm: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: ism.deployed.address },
          },
          defaultHook: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: hookAddress },
          },
          requiredHook: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: hookAddress },
          },
        },
      });
    mailboxAddress = mailbox.deployed.address;
    artifactManager = new StarknetValidatorAnnounceArtifactManager(
      TEST_STARKNET_CHAIN_METADATA,
    );
  });

  it('creates and reads validator announce artifact', async () => {
    const writer = artifactManager.createWriter('validatorAnnounce', signer);
    const [created] = await writer.create({
      config: { mailboxAddress },
    });

    expect(created.deployed.address).to.not.equal('');
    expect(
      eqAddressStarknet(created.config.mailboxAddress, mailboxAddress),
    ).to.equal(true);

    const reader = artifactManager.createReader('validatorAnnounce');
    const read = await reader.read(created.deployed.address);

    expect(
      eqAddressStarknet(read.deployed.address, created.deployed.address),
    ).to.equal(true);
    expect(
      eqAddressStarknet(read.config.mailboxAddress, mailboxAddress),
    ).to.equal(true);
  });

  it('returns no update txs for immutable validator announce', async () => {
    const writer = artifactManager.createWriter('validatorAnnounce', signer);
    const [created] = await writer.create({
      config: { mailboxAddress },
    });

    const updateTxs = await writer.update(created);
    expect(updateTxs).to.have.length(0);
  });
});
