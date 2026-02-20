import { expect } from 'chai';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { eqAddressStarknet } from '@hyperlane-xyz/utils';

import { StarknetSigner } from '../clients/signer.js';
import { StarknetHookArtifactManager } from '../hook/hook-artifact-manager.js';
import {
  DEFAULT_E2E_TEST_TIMEOUT,
  TEST_STARKNET_CHAIN_METADATA,
} from '../testing/constants.js';
import { createSigner } from '../testing/utils.js';

describe('3. starknet sdk hook e2e tests', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let signer: StarknetSigner;
  let mailboxAddress: string;
  let artifactManager: StarknetHookArtifactManager;

  before(async () => {
    signer = await createSigner();
    const mailbox = await signer.createMailbox({
      domainId: TEST_STARKNET_CHAIN_METADATA.domainId,
      defaultIsmAddress: undefined,
    });
    mailboxAddress = mailbox.mailboxAddress;
    artifactManager = new StarknetHookArtifactManager(TEST_STARKNET_CHAIN_METADATA, {
      mailbox: mailboxAddress,
    });
  });

  it('creates and reads merkle tree hook', async () => {
    const writer = artifactManager.createWriter(AltVM.HookType.MERKLE_TREE, signer);
    const [created] = await writer.create({
      config: { type: AltVM.HookType.MERKLE_TREE },
    });

    expect(created.deployed.address).to.not.equal('');

    const reader = artifactManager.createReader(AltVM.HookType.MERKLE_TREE);
    const read = await reader.read(created.deployed.address);
    expect(read.config.type).to.equal(AltVM.HookType.MERKLE_TREE);
    expect(eqAddressStarknet(read.deployed.address, created.deployed.address)).to.equal(
      true,
    );

    const updateTxs = await writer.update(created);
    expect(updateTxs).to.have.length(0);
  });

  it('creates, reads, and updates protocol fee hook', async () => {
    const writer = artifactManager.createWriter(AltVM.HookType.PROTOCOL_FEE, signer);
    const [created] = await writer.create({
      config: {
        type: AltVM.HookType.PROTOCOL_FEE,
        owner: signer.getSignerAddress(),
        beneficiary: '0x1111111111111111111111111111111111111111111111111111111111111111',
        maxProtocolFee: '20',
        protocolFee: '10',
      },
    });

    const reader = artifactManager.createReader(AltVM.HookType.PROTOCOL_FEE);
    const read = await reader.read(created.deployed.address);
    expect(read.config.type).to.equal(AltVM.HookType.PROTOCOL_FEE);
    expect(read.config.maxProtocolFee).to.equal('20');
    expect(read.config.protocolFee).to.equal('10');

    const newOwner =
      '0x2222222222222222222222222222222222222222222222222222222222222222';
    const txs = await writer.update({
      ...created,
      config: {
        ...created.config,
        owner: newOwner,
        beneficiary:
          '0x3333333333333333333333333333333333333333333333333333333333333333',
        protocolFee: '11',
      },
    });

    expect(txs.length).to.be.greaterThan(0);
    expect(txs[txs.length - 1].annotation).to.contain('ownership');

    for (const tx of txs) {
      await signer.sendAndConfirmTransaction(tx as any);
    }

    const updated = await reader.read(created.deployed.address);
    expect(eqAddressStarknet(updated.config.owner, newOwner)).to.equal(true);
    expect(updated.config.protocolFee).to.equal('11');
    expect(
      eqAddressStarknet(
        updated.config.beneficiary,
        '0x3333333333333333333333333333333333333333333333333333333333333333',
      ),
    ).to.equal(true);
  });
});
