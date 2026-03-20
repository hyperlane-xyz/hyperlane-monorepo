import { expect } from 'chai';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { eqAddressStarknet } from '@hyperlane-xyz/utils';

import { StarknetSigner } from '../clients/signer.js';
import { StarknetIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import { StarknetMailboxArtifactManager } from '../mailbox/mailbox-artifact-manager.js';
import {
  DEFAULT_E2E_TEST_TIMEOUT,
  TEST_STARKNET_CHAIN_METADATA,
} from '../testing/constants.js';
import { createSigner } from '../testing/utils.js';

describe('2. starknet sdk mailbox e2e tests', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let signer: StarknetSigner;
  let artifactManager: StarknetMailboxArtifactManager;
  let ismArtifactManager: StarknetIsmArtifactManager;

  before(async () => {
    signer = await createSigner();
    artifactManager = new StarknetMailboxArtifactManager(
      TEST_STARKNET_CHAIN_METADATA,
    );
    ismArtifactManager = new StarknetIsmArtifactManager(
      TEST_STARKNET_CHAIN_METADATA,
    );
  });

  async function createPrerequisites() {
    const [ism] = await ismArtifactManager
      .createWriter(AltVM.IsmType.TEST_ISM, signer)
      .create({
        config: { type: AltVM.IsmType.TEST_ISM },
      });
    const hook = await signer.createNoopHook({ mailboxAddress: '' });

    return {
      ismAddress: ism.deployed.address,
      hookAddress: hook.hookAddress,
    };
  }

  it('creates and reads mailbox artifact', async () => {
    const { ismAddress, hookAddress } = await createPrerequisites();

    const writer = artifactManager.createWriter('mailbox', signer);
    const [created, receipts] = await writer.create({
      config: {
        owner: signer.getSignerAddress(),
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ismAddress },
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

    expect(created.deployed.address).to.not.equal('');
    expect(created.deployed.domainId).to.equal(
      TEST_STARKNET_CHAIN_METADATA.domainId,
    );
    expect(receipts.length).to.be.greaterThan(0);

    const reader = artifactManager.createReader('mailbox');
    const read = await reader.read(created.deployed.address);
    expect(
      eqAddressStarknet(read.config.owner, signer.getSignerAddress()),
    ).to.equal(true);
    expect(
      eqAddressStarknet(read.config.defaultIsm.deployed.address, ismAddress),
    ).to.equal(true);
    expect(
      eqAddressStarknet(read.config.defaultHook.deployed.address, hookAddress),
    ).to.equal(true);
    expect(
      eqAddressStarknet(read.config.requiredHook.deployed.address, hookAddress),
    ).to.equal(true);
  });

  it('updates mailbox ISM/hooks/owner', async () => {
    const base = await createPrerequisites();
    const next = await createPrerequisites();

    const writer = artifactManager.createWriter('mailbox', signer);
    const [created] = await writer.create({
      config: {
        owner: signer.getSignerAddress(),
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: base.ismAddress },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: base.hookAddress },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: base.hookAddress },
        },
      },
    });

    const newOwner = '0x1234567890abcdef1234567890abcdef1234567890abcdef';
    const txs = await writer.update({
      ...created,
      config: {
        owner: newOwner,
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: next.ismAddress },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: next.hookAddress },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: next.hookAddress },
        },
      },
    });

    expect(txs.length).to.be.greaterThan(0);
    for (const tx of txs) {
      await signer.sendAndConfirmTransaction(tx);
    }

    const updated = await artifactManager.readMailbox(created.deployed.address);
    expect(eqAddressStarknet(updated.config.owner, newOwner)).to.equal(true);
    expect(
      eqAddressStarknet(
        updated.config.defaultIsm.deployed.address,
        next.ismAddress,
      ),
    ).to.equal(true);
    expect(
      eqAddressStarknet(
        updated.config.defaultHook.deployed.address,
        next.hookAddress,
      ),
    ).to.equal(true);
    expect(
      eqAddressStarknet(
        updated.config.requiredHook.deployed.address,
        next.hookAddress,
      ),
    ).to.equal(true);
  });
});
