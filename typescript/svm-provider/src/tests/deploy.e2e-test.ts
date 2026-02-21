/* eslint-disable no-console */
import { expect } from 'chai';
import { after, before, describe, it } from 'mocha';
// eslint-disable-next-line import/no-nodejs-modules
import * as fs from 'fs';

import { fetchEncodedAccount } from '@solana/kit';

import {
  createDeployProgramPlan,
  executeDeployPlan,
  type DeployStage,
} from '../deploy/program-deployer.js';
import { createRpc } from '../rpc.js';
import { type SvmSigner, createSigner } from '../signer.js';
import {
  airdropSol,
  DEFAULT_PROGRAMS_PATH,
  PROGRAM_BINARIES,
} from '../testing/setup.js';
import {
  type SolanaTestValidator,
  startSolanaTestValidator,
  waitForRpcReady,
} from '../testing/solana-container.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

const SKIP_DEPLOY_TEST = !process.env.DEPLOY_TEST;

describe('SVM Deploy E2E Tests', function () {
  this.timeout(300_000);

  let solana: SolanaTestValidator;
  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner & { address: string };

  before(async function () {
    if (SKIP_DEPLOY_TEST) {
      this.skip();
      return;
    }

    console.log('Starting Solana test validator (no preloaded programs)...');
    solana = await startSolanaTestValidator({});
    console.log(`Validator started at: ${solana.rpcUrl}`);

    await waitForRpcReady(solana.rpcUrl);

    rpc = createRpc(solana.rpcUrl);
    signer = await createSigner(TEST_PRIVATE_KEY, rpc);

    console.log(`Airdropping SOL to ${signer.address}...`);
    await airdropSol(rpc, signer.address as any);
  });

  after(async () => {
    if (solana) {
      await solana.stop();
    }
  });

  it('should deploy a .so program via loader-v3', async function () {
    if (SKIP_DEPLOY_TEST) {
      this.skip();
      return;
    }

    const soPath = `${DEFAULT_PROGRAMS_PATH}/${PROGRAM_BINARIES.testIsm}`;
    if (!fs.existsSync(soPath)) {
      console.log(`Skipping: .so file not found at ${soPath}`);
      this.skip();
      return;
    }

    const programBytes = new Uint8Array(fs.readFileSync(soPath));

    const plan = await createDeployProgramPlan({
      payer: signer.signer,
      programBytes,
      getMinimumBalanceForRentExemption: async (size: number) => {
        const result = await rpc
          .getMinimumBalanceForRentExemption(BigInt(size))
          .send();
        return result;
      },
    });

    console.log(
      `Deploy plan: ${plan.stages.length} stages for program ${plan.programAddress}`,
    );

    const receipts = await executeDeployPlan({
      plan,
      executeStage: async (stage: DeployStage) => {
        return signer.send({
          instructions: stage.instructions,
          additionalSigners: stage.additionalSigners,
        });
      },
    });

    expect(receipts.length).to.be.greaterThan(0);

    const account = await fetchEncodedAccount(rpc, plan.programAddress);
    expect(account.exists).to.be.true;
    console.log(`Program deployed at: ${plan.programAddress}`);
  });
});
