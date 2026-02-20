import { expect } from 'chai';
import { after, before, describe, it } from 'mocha';
// eslint-disable-next-line import/no-nodejs-modules
import * as fs from 'fs/promises';
// eslint-disable-next-line import/no-nodejs-modules
import * as path from 'path';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';

import { createRpc } from '../rpc.js';
import { createSigner, type SvmSigner } from '../signer.js';
import {
  airdropSol,
  DEFAULT_PROGRAMS_PATH,
  getPreloadedPrograms,
} from '../testing/setup.js';
import {
  startSolanaTestValidator,
  waitForRpcReady,
  type SolanaTestValidator,
} from '../testing/solana-container.js';
import { SvmNativeTokenReader, SvmNativeTokenWriter } from '../warp/native-token.js';
import type { Address } from '@solana/kit';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

// Preload mailbox so we have a real mailbox address
const PRELOADED_PROGRAMS: Array<keyof typeof import('../testing/setup.js').PROGRAM_BINARIES> = [
  'mailbox',
];

describe('SVM Native Warp Token E2E Tests', function () {
  this.timeout(300_000); // 5 minutes for program deployment

  let solana: SolanaTestValidator;
  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let programBytes: Uint8Array;
  let mailboxAddress: Address;

  before(async () => {
    // Start validator with preloaded mailbox
    const preloadedPrograms = getPreloadedPrograms(PRELOADED_PROGRAMS);
    console.log('Starting Solana test validator with mailbox...');
    solana = await startSolanaTestValidator({ preloadedPrograms });
    console.log(`Validator started at: ${solana.rpcUrl}`);

    await waitForRpcReady(solana.rpcUrl);

    rpc = createRpc(solana.rpcUrl);
    signer = await createSigner(TEST_PRIVATE_KEY);

    console.log(`Airdropping SOL to ${signer.address}...`);
    await airdropSol(rpc, signer.address);

    // Get mailbox address from preloaded programs
    mailboxAddress = preloadedPrograms[0].programId as Address;
    console.log(`Mailbox address: ${mailboxAddress}`);

    // Load native token program bytes for deployment
    const programPath = path.join(
      DEFAULT_PROGRAMS_PATH,
      'hyperlane_sealevel_token_native.so',
    );
    programBytes = new Uint8Array(await fs.readFile(programPath));
    console.log(`Loaded native token program: ${programBytes.length} bytes`);
  });

  after(async () => {
    console.log('\n=================================================');
    console.log('Validator kept running for debugging');
    console.log(`RPC URL: ${solana?.rpcUrl ?? 'http://127.0.0.1:8899'}`);
    console.log('=================================================');
    console.log('\nTo query transactions:');
    console.log('  solana confirm <SIGNATURE> --url http://127.0.0.1:8899 -v');
    console.log('\nTo stop validator manually:');
    console.log('  pkill solana-test-validator');
    console.log('\nValidator will stay running until you kill it.');
    console.log('=================================================\n');

    // Don't stop validator - keep it running for debugging
    // if (solana) {
    //   await solana.stop();
    // }
  });

  describe('Native Token', () => {
    let deployedProgramId: string;

    it('should deploy and initialize native token from scratch', async () => {
      const writer = new SvmNativeTokenWriter(rpc, signer, programBytes);

      const config = {
        type: 'native' as const,
        owner: signer.address,
        mailbox: mailboxAddress,
        remoteRouters: {},
        destinationGas: {},
      };

      console.log('Creating native token (deploy + initialize)...');
      const [deployed, receipts] = await writer.create({ config });

      deployedProgramId = deployed.deployed.address;
      console.log(`Deployed at: ${deployedProgramId}`);
      console.log(`Total transactions: ${receipts.length}`);

      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(deployed.config.type).to.equal('native');
      expect(deployed.deployed.address).to.be.a('string');
      expect(receipts.length).to.be.greaterThan(0);
    });

    it('should read deployed token config', async () => {
      const reader = new SvmNativeTokenReader(rpc);
      const token = await reader.read(deployedProgramId);

      expect(token.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(token.config.type).to.equal('native');
      expect(token.config.owner).to.equal(signer.address);
      expect(token.config.mailbox).to.equal(mailboxAddress);
    });

    it('should enroll remote routers', async () => {
      const reader = new SvmNativeTokenReader(rpc);
      const writer = new SvmNativeTokenWriter(rpc, signer, programBytes);

      const current = await reader.read(deployedProgramId);

      const updatedConfig = {
        ...current.config,
        remoteRouters: {
          1: {
            address:
              '0x1111111111111111111111111111111111111111111111111111111111111111',
          },
          2: {
            address:
              '0x2222222222222222222222222222222222222222222222222222222222222222',
          },
        },
        destinationGas: {
          1: '100000',
          2: '200000',
        },
      };

      console.log('Enrolling remote routers...');
      const updateTxs = await writer.update({
        artifactState: ArtifactState.DEPLOYED,
        config: updatedConfig,
        deployed: current.deployed,
      });

      console.log(`Update txs: ${updateTxs.length}`);
      expect(updateTxs.length).to.be.greaterThan(0);

      for (const tx of updateTxs) {
        console.log(`Executing: ${tx.annotation}`);
        for (const ix of tx.instructions) {
          await signer.signAndSend(rpc, { instructions: [ix] });
        }
      }

      const updated = await reader.read(deployedProgramId);
      expect(updated.config.remoteRouters[1]?.address).to.equal(
        '0x1111111111111111111111111111111111111111111111111111111111111111',
      );
      expect(updated.config.remoteRouters[2]?.address).to.equal(
        '0x2222222222222222222222222222222222222222222222222222222222222222',
      );
    });

    it('should unenroll routers', async () => {
      const reader = new SvmNativeTokenReader(rpc);
      const writer = new SvmNativeTokenWriter(rpc, signer, programBytes);

      const current = await reader.read(deployedProgramId);

      const updatedConfig = {
        ...current.config,
        remoteRouters: {
          1: current.config.remoteRouters[1]!,
        },
        destinationGas: {
          1: current.config.destinationGas[1]!,
        },
      };

      console.log('Unenrolling domain 2...');
      const updateTxs = await writer.update({
        artifactState: ArtifactState.DEPLOYED,
        config: updatedConfig,
        deployed: current.deployed,
      });

      for (const tx of updateTxs) {
        for (const ix of tx.instructions) {
          await signer.signAndSend(rpc, { instructions: [ix] });
        }
      }

      const updated = await reader.read(deployedProgramId);
      expect(updated.config.remoteRouters[1]).to.exist;
      expect(updated.config.remoteRouters[2]).to.be.undefined;
    });
  });
});
