import { expect } from 'chai';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { assert, eqAddressStarknet } from '@hyperlane-xyz/utils';

import { StarknetSigner } from '../clients/signer.js';
import { StarknetHookArtifactManager } from '../hook/hook-artifact-manager.js';
import { StarknetIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import { StarknetMailboxArtifactManager } from '../mailbox/mailbox-artifact-manager.js';
import {
  DEFAULT_E2E_TEST_TIMEOUT,
  TEST_STARKNET_CHAIN_METADATA,
} from '../testing/constants.js';
import { createSigner } from '../testing/utils.js';
import { StarknetAnnotatedTx } from '../types.js';

describe('3. starknet sdk hook e2e tests', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let signer: StarknetSigner;
  let mailboxAddress: string;
  let artifactManager: StarknetHookArtifactManager;

  before(async () => {
    signer = await createSigner();

    const ismArtifactManager = new StarknetIsmArtifactManager(
      TEST_STARKNET_CHAIN_METADATA,
    );
    const [ism] = await ismArtifactManager
      .createWriter(AltVM.IsmType.TEST_ISM, signer)
      .create({ config: { type: AltVM.IsmType.TEST_ISM } });

    const hookTx = await signer.getCreateNoopHookTransaction({
      signer: signer.getSignerAddress(),
      mailboxAddress: signer.getSignerAddress(),
    });
    const hookReceipt = await signer.sendAndConfirmTransaction(hookTx);
    assert(hookReceipt.contractAddress, 'failed to deploy noop hook');
    const hookAddress = hookReceipt.contractAddress;

    const mailboxArtifactManager = new StarknetMailboxArtifactManager(
      TEST_STARKNET_CHAIN_METADATA,
    );
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
    artifactManager = new StarknetHookArtifactManager(
      TEST_STARKNET_CHAIN_METADATA,
      {
        mailbox: mailboxAddress,
      },
    );
  });

  it('creates and reads merkle tree hook', async () => {
    const writer = artifactManager.createWriter(
      AltVM.HookType.MERKLE_TREE,
      signer,
    );
    const [created] = await writer.create({
      config: { type: AltVM.HookType.MERKLE_TREE },
    });

    expect(created.deployed.address).to.not.equal('');

    const reader = artifactManager.createReader(AltVM.HookType.MERKLE_TREE);
    const read = await reader.read(created.deployed.address);
    expect(read.config.type).to.equal(AltVM.HookType.MERKLE_TREE);
    expect(
      eqAddressStarknet(read.deployed.address, created.deployed.address),
    ).to.equal(true);

    const updateTxs = await writer.update(created);
    expect(updateTxs).to.have.length(0);
  });

  it('creates, reads, and updates protocol fee hook', async () => {
    const writer = artifactManager.createWriter(
      AltVM.HookType.PROTOCOL_FEE,
      signer,
    );
    const [created] = await writer.create({
      config: {
        type: AltVM.HookType.PROTOCOL_FEE,
        owner: signer.getSignerAddress(),
        beneficiary: '0x111',
        maxProtocolFee: '20',
        protocolFee: '10',
      },
    });

    const reader = artifactManager.createReader(AltVM.HookType.PROTOCOL_FEE);
    const read = await reader.read(created.deployed.address);
    expect(read.config.type).to.equal(AltVM.HookType.PROTOCOL_FEE);
    expect(read.config.protocolFee).to.equal('10');

    const newOwner = '0x222';
    const txs = await writer.update({
      ...created,
      config: {
        ...created.config,
        owner: newOwner,
        beneficiary: '0x333',
        protocolFee: '11',
      },
    });

    expect(txs.length).to.be.greaterThan(0);
    expect(txs[txs.length - 1]?.annotation).to.contain('ownership');

    for (const tx of txs) {
      await signer.sendAndConfirmTransaction(tx as StarknetAnnotatedTx);
    }

    const updated = await reader.read(created.deployed.address);
    expect(eqAddressStarknet(updated.config.owner, newOwner)).to.equal(true);
    expect(updated.config.protocolFee).to.equal('11');
    expect(eqAddressStarknet(updated.config.beneficiary, '0x333')).to.equal(
      true,
    );
  });
});
