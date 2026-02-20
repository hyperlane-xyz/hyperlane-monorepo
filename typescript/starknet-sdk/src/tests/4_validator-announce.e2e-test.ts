import { expect } from 'chai';

import { eqAddressStarknet } from '@hyperlane-xyz/utils';

import { StarknetSigner } from '../clients/signer.js';
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

  before(async () => {
    signer = await createSigner();
    const mailbox = await signer.createMailbox({
      domainId: TEST_STARKNET_CHAIN_METADATA.domainId,
      defaultIsmAddress: undefined,
    });
    mailboxAddress = mailbox.mailboxAddress;
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
    expect(eqAddressStarknet(created.config.mailboxAddress, mailboxAddress)).to.equal(
      true,
    );

    const reader = artifactManager.createReader('validatorAnnounce');
    const read = await reader.read(created.deployed.address);

    expect(eqAddressStarknet(read.deployed.address, created.deployed.address)).to.equal(
      true,
    );
    expect(eqAddressStarknet(read.config.mailboxAddress, mailboxAddress)).to.equal(
      true,
    );
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
