import { expect } from 'chai';
import { before, describe, it } from 'mocha';

import { assert, sleep } from '@hyperlane-xyz/utils';

import { SvmSigner } from '../clients/signer.js';
import {
  EXTEND_PROGRAM_CHECKED_FEATURE,
  MIN_PROGRAM_DATA_EXTEND_BYTES,
} from '../constants.js';
import {
  PROGRAM_DATA_HEADER_SIZE,
  createDeployProgramPlan,
  executeDeployPlan,
} from '../deploy/program-deployer.js';
import { prepareProgramUpgrade } from '../deploy/program-upgrade.js';
import { isFeatureActive } from '../feature-gate.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import { deriveProgramDataAddress } from '../pda.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { LEGACY_SVM_PROGRAM_BYTES } from '../testing/legacy/legacy-program-bytes.js';
import { airdropSol } from '../testing/setup.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

// Deploy the legacy binary into a program-data account sized just under the
// new binary, so the upgrade needs a sub-minimum extend and exercises the
// loader's 10240-byte floor.
const FORCED_DEFICIT = 5_000;

// `skipPreflight` and the post-send sleep below are test-validator-only
// workarounds. On mainnet the signer waits for the tx to land on chain, which
// gives the cluster time to refresh its program cache before the next read.
// The local test validator confirms much faster, so without these guards the
// follow-up read can race the validator's program cache and see stale state.

describe('SVM ExtendProgram (feature-gate inactive) E2E', function () {
  this.timeout(600_000);

  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;

  before(async () => {
    rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    signer = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      TEST_PRIVATE_KEY,
    );
    await airdropSol(rpc, signer.getSignerAddress(), 100_000_000_000n);
  });

  it('extends via the unchecked variant and upgrades when ExtendProgramChecked is unavailable', async () => {
    expect(await isFeatureActive(rpc, EXTEND_PROGRAM_CHECKED_FEATURE)).to.equal(
      false,
    );

    const oldBytes = LEGACY_SVM_PROGRAM_BYTES.tokenCollateral;
    const newBytes = HYPERLANE_SVM_PROGRAM_BYTES.tokenCollateral;
    const maxDataLen = newBytes.length - FORCED_DEFICIT;
    assert(
      maxDataLen >= oldBytes.length,
      'tight maxDataLen must still fit the legacy binary',
    );

    const getMinimumBalanceForRentExemption = (size: number) =>
      rpc.getMinimumBalanceForRentExemption(BigInt(size)).send();

    const deployPlan = await createDeployProgramPlan({
      payer: signer.signer,
      authority: signer.signer,
      programBytes: oldBytes,
      maxDataLen: BigInt(maxDataLen),
      getMinimumBalanceForRentExemption,
    });
    await executeDeployPlan({
      plan: deployPlan,
      executeStage: async (stage) =>
        signer.send({
          instructions: stage.instructions,
          additionalSigners: stage.additionalSigners,
        }),
    });

    const programId = deployPlan.programAddress;
    const programDataAddress = await deriveProgramDataAddress(programId);

    const initial = await rpc
      .getAccountInfo(programDataAddress, { encoding: 'base64' })
      .send();
    assert(initial.value, 'program data account should exist after deploy');
    const initialSize = Buffer.from(initial.value.data[0], 'base64').length;

    const upgrade = await prepareProgramUpgrade(
      programId,
      '1.0.0',
      '2.0.0',
      newBytes,
      signer,
      rpc,
      'extend-upgrade-test',
    );
    assert(upgrade, 'expected an upgrade to be prepared');

    for (const tx of upgrade.authorityTransactions) {
      await signer.send({
        instructions: tx.instructions,
        additionalSigners: tx.additionalSigners,
        skipPreflight: true,
      });
    }
    await sleep(1000);

    const after = await rpc
      .getAccountInfo(programDataAddress, { encoding: 'base64' })
      .send();
    assert(after.value, 'program data account should still exist');
    const afterData = Buffer.from(after.value.data[0], 'base64');

    // Deficit was below the loader minimum, so the extend clamps up to it.
    expect(afterData.length).to.equal(
      initialSize + MIN_PROGRAM_DATA_EXTEND_BYTES,
    );

    // The upgrade copied the new binary into the program-data account.
    const deployedBytecode = afterData.subarray(
      PROGRAM_DATA_HEADER_SIZE,
      PROGRAM_DATA_HEADER_SIZE + newBytes.length,
    );
    expect(deployedBytecode.equals(Buffer.from(newBytes))).to.equal(true);
  });
});
