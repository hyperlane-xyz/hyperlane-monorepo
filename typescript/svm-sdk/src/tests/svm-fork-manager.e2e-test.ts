import { address, generateKeyPairSigner } from '@solana/kit';
import { expect } from 'chai';
import { after, before, describe, it } from 'mocha';

import { assert, isNullish, pollAsync } from '@hyperlane-xyz/utils';

import { SvmSigner } from '../clients/signer.js';
import {
  type SvmForkManager,
  createSvmForkManager,
} from '../fork/svm-fork-manager.js';
import {
  getInitializeMultisigIsmMessageIdInstruction,
  getTransferOwnershipInstruction,
} from '../instructions/multisig-ism-message-id.js';
import { fetchMultisigIsmAccessControl } from '../ism/ism-query.js';
import { type SolanaRpcClient, createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { TEST_PROGRAM_IDS, airdropSol } from '../testing/setup.js';
import { runSurfpoolContainer } from '../testing/surfpool-container.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';
const FORK_RPC_PORT = 8899;

describe('SvmForkManager fork replay e2e', function () {
  this.timeout(300_000);

  const programId = address(TEST_PROGRAM_IDS.multisigIsm);

  let upstreamRpc: SolanaRpcClient;
  let signer: SvmSigner;
  let manager: SvmForkManager | undefined;

  before(async () => {
    upstreamRpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    signer = await SvmSigner.connectWithSigner(
      TEST_SVM_CHAIN_METADATA,
      TEST_PRIVATE_KEY,
    );

    await airdropSol(upstreamRpc, address(signer.getSignerAddress()));

    const initIx = await getInitializeMultisigIsmMessageIdInstruction(
      programId,
      signer.signer,
    );
    const initReceipt = await signer.send({
      instructions: [initIx],
      skipPreflight: true,
    });

    // The fork datasource fetches accounts at finalized commitment; wait until
    // the init is finalized on the upstream before forking so copy-on-read sees
    // the initialized PDA.
    const initSlot = initReceipt.slot;
    assert(!isNullish(initSlot), 'init receipt missing slot');
    await pollAsync(
      async () => {
        const finalizedSlot = await upstreamRpc
          .getSlot({ commitment: 'finalized' })
          .send();
        assert(
          finalizedSlot >= initSlot,
          `finalized slot ${finalizedSlot} has not reached init slot ${initSlot}`,
        );
      },
      1000,
      90,
    );
  });

  after(() => {
    manager?.kill();
  });

  it('forks the upstream and replays an ownership transfer that mutates only the fork', async () => {
    const signerAddress = address(signer.getSignerAddress());

    const upstreamBefore = await fetchMultisigIsmAccessControl(
      upstreamRpc,
      programId,
    );
    assert(upstreamBefore, 'access control PDA missing on upstream after init');
    expect(upstreamBefore.owner).to.equal(signerAddress);

    const newOwner = (await generateKeyPairSigner()).address;
    const transferIx = await getTransferOwnershipInstruction(
      programId,
      signer.signer,
      newOwner,
    );
    const printable = await signer.transactionToPrintableJson({
      instructions: [transferIx],
      feePayer: signerAddress,
      annotation: 'transfer multisig ISM ownership',
    });

    manager = createSvmForkManager({
      chainName: 'sealeveltest',
      upstreamRpcUrl: TEST_SVM_CHAIN_METADATA.rpcUrl,
      rpcPort: FORK_RPC_PORT,
      runNode: runSurfpoolContainer,
    });
    await manager.start();

    await manager.applyForkConfig({ transactions: [printable] });

    const forkRpc = createRpc(manager.getForkedChainMetadata().rpcUrls[0].http);
    const forkAfter = await fetchMultisigIsmAccessControl(forkRpc, programId);
    assert(forkAfter, 'access control PDA missing on fork');
    expect(forkAfter.owner).to.equal(newOwner);

    const upstreamAfter = await fetchMultisigIsmAccessControl(
      upstreamRpc,
      programId,
    );
    assert(upstreamAfter, 'access control PDA missing on upstream');
    expect(upstreamAfter.owner).to.equal(signerAddress);
  });
});
