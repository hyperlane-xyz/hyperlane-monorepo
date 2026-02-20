import type { Address } from '@solana/kit';
import { expect } from 'chai';
import { after, before, describe, it } from 'mocha';
// eslint-disable-next-line import/no-nodejs-modules
import * as path from 'path';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';

import { createRpc } from '../rpc.js';
import { type SvmSigner, createSigner } from '../signer.js';
import {
  DEFAULT_PROGRAMS_PATH,
  airdropSol,
  getPreloadedPrograms,
} from '../testing/setup.js';
import {
  type SolanaTestValidator,
  startSolanaTestValidator,
  waitForRpcReady,
} from '../testing/solana-container.js';
import {
  SvmSyntheticTokenReader,
  SvmSyntheticTokenWriter,
} from '../warp/synthetic-token.js';
// eslint-disable-next-line import/no-nodejs-modules
import * as fs from 'fs/promises';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

const PRELOADED_PROGRAMS: Array<
  keyof typeof import('../testing/setup.js').PROGRAM_BINARIES
> = ['mailbox'];

describe('SVM Synthetic Warp Token E2E Tests', function () {
  this.timeout(300_000);

  let solana: SolanaTestValidator;
  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let programBytes: Uint8Array;
  let mailboxAddress: Address;

  before(async () => {
    const preloadedPrograms = getPreloadedPrograms(PRELOADED_PROGRAMS);
    console.log('Starting validator with mailbox...');
    solana = await startSolanaTestValidator({ preloadedPrograms });
    await waitForRpcReady(solana.rpcUrl);

    rpc = createRpc(solana.rpcUrl);
    signer = await createSigner(TEST_PRIVATE_KEY);
    await airdropSol(rpc, signer.address);

    mailboxAddress = preloadedPrograms[0].programId as Address;
    console.log(`Mailbox: ${mailboxAddress}`);

    const programPath = path.join(
      DEFAULT_PROGRAMS_PATH,
      'hyperlane_sealevel_token.so',
    );
    programBytes = new Uint8Array(await fs.readFile(programPath));
    console.log(`Loaded synthetic program: ${programBytes.length} bytes`);
  });

  after(async () => {
    console.log('\n=== Validator kept running for debugging ===');
    console.log(`RPC: http://127.0.0.1:8899`);
    console.log('Stop with: pkill solana-test-validator');
    // Don't stop - keep for debugging
    // if (solana) {
    //   await solana.stop();
    // }
  });

  describe('Synthetic Token', () => {
    let deployedProgramId: string;

    it.only('should deploy and initialize synthetic token', async () => {
      const writer = new SvmSyntheticTokenWriter(
        rpc,
        signer,
        programBytes,
        solana.rpcUrl,
      );

      const config = {
        type: 'synthetic' as const,
        owner: signer.address,
        mailbox: mailboxAddress,
        remoteRouters: {},
        destinationGas: {},
        name: 'Test Token',
        symbol: 'TEST',
        decimals: 6,
      };

      console.log('Creating synthetic token...');
      const [deployed, receipts] = await writer.create({ config });

      deployedProgramId = deployed.deployed.address;
      console.log(`Deployed: ${deployedProgramId}`);
      console.log(`Receipts: ${receipts.length}`);

      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(deployed.config.type).to.equal('synthetic');
      expect(deployed.deployed.address).to.be.a('string');
      expect(receipts.length).to.be.greaterThan(0);
    });

    it('should read synthetic token config and validate metadata', async () => {
      const reader = new SvmSyntheticTokenReader(rpc, solana.rpcUrl);
      const token = await reader.read(deployedProgramId);

      expect(token.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(token.config.type).to.equal('synthetic');
      expect(token.config.decimals).to.equal(6);
      expect(token.config.mailbox).to.equal(mailboxAddress);

      // Validate metadata is set correctly
      console.log('Metadata:', {
        name: token.config.name,
        symbol: token.config.symbol,
      });
      expect(token.config.name).to.equal('Test Token');
      expect(token.config.symbol).to.equal('TEST');
    });

    it('should enroll remote routers', async () => {
      const reader = new SvmSyntheticTokenReader(rpc, solana.rpcUrl);
      const writer = new SvmSyntheticTokenWriter(
        rpc,
        signer,
        programBytes,
        solana.rpcUrl,
      );

      const current = await reader.read(deployedProgramId);

      const updatedConfig = {
        ...current.config,
        remoteRouters: {
          1: {
            address:
              '0x1111111111111111111111111111111111111111111111111111111111111111',
          },
        },
        destinationGas: {
          1: '100000',
        },
      };

      const updateTxs = await writer.update({
        artifactState: ArtifactState.DEPLOYED,
        config: updatedConfig,
        deployed: current.deployed,
      });

      expect(updateTxs.length).to.be.greaterThan(0);

      for (const tx of updateTxs) {
        for (const ix of tx.instructions) {
          await signer.signAndSend(rpc, { instructions: [ix] });
        }
      }

      const updated = await reader.read(deployedProgramId);

      console.log(JSON.stringify(updated, null, 2));

      expect(updated.config.remoteRouters[1]).to.exist;
      expect(updated.config.remoteRouters[1]?.address).to.equal(
        '0x1111111111111111111111111111111111111111111111111111111111111111',
      );
    });
  });
});
