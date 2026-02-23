import type { Address } from '@solana/kit';
import { expect } from 'chai';
import { after, before, describe, it } from 'mocha';
// eslint-disable-next-line import/no-nodejs-modules
import * as path from 'path';

import { HookType } from '@hyperlane-xyz/provider-sdk/altvm';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';

import { SvmIgpHookWriter, deriveIgpSalt } from '../hook/igp-hook.js';
import { getOverheadIgpAccountPda } from '../pda.js';
import { createRpc } from '../rpc.js';
import { type SvmSigner, createSigner } from '../signer.js';
import {
  DEFAULT_PROGRAMS_PATH,
  TEST_PROGRAM_IDS,
  airdropSol,
  getPreloadedPrograms,
} from '../testing/setup.js';
import {
  type SolanaTestValidator,
  startSolanaTestValidator,
  waitForRpcReady,
} from '../testing/solana-container.js';
import {
  SvmNativeTokenReader,
  SvmNativeTokenWriter,
} from '../warp/native-token.js';
// eslint-disable-next-line import/no-nodejs-modules
import * as fs from 'fs/promises';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

// Preload mailbox + igp
const PRELOADED_PROGRAMS: Array<
  keyof typeof import('../testing/setup.js').PROGRAM_BINARIES
> = ['mailbox', 'igp'];

describe('SVM Native Warp Token E2E Tests', function () {
  this.timeout(300_000); // 5 minutes for program deployment

  let solana: SolanaTestValidator;
  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let programBytes: Uint8Array;
  let mailboxAddress: Address;
  let igpProgramId: Address;
  let overheadIgpAccountAddress: Address;

  before(async () => {
    // Start validator with preloaded mailbox + igp
    const preloadedPrograms = getPreloadedPrograms(PRELOADED_PROGRAMS);
    console.log('Starting Solana test validator with mailbox + igp...');
    solana = await startSolanaTestValidator({ preloadedPrograms });
    console.log(`Validator started at: ${solana.rpcUrl}`);

    await waitForRpcReady(solana.rpcUrl);

    rpc = createRpc(solana.rpcUrl);
    signer = await createSigner(TEST_PRIVATE_KEY);

    console.log(`Airdropping SOL to ${signer.address}...`);
    await airdropSol(rpc, signer.address, 50_000_000_000n); // 50 SOL — multiple program deployments per test

    mailboxAddress = TEST_PROGRAM_IDS.mailbox;
    igpProgramId = TEST_PROGRAM_IDS.igp;
    console.log(`Mailbox address: ${mailboxAddress}`);
    console.log(`IGP program: ${igpProgramId}`);

    // Initialize IGP + overhead IGP accounts
    const igpSalt = deriveIgpSalt('hyperlane-test');
    const igpWriter = new SvmIgpHookWriter(rpc, igpProgramId, igpSalt, signer);
    await igpWriter.create({
      artifactState: ArtifactState.NEW,
      config: {
        type: HookType.INTERCHAIN_GAS_PAYMASTER as 'interchainGasPaymaster',
        owner: signer.address,
        beneficiary: signer.address,
        oracleKey: signer.address,
        overhead: { 1: 50000 },
        oracleConfig: {
          1: { gasPrice: '1', tokenExchangeRate: '1000000000000000000' },
        },
      },
    });

    const [overheadPda] = await getOverheadIgpAccountPda(igpProgramId, igpSalt);
    overheadIgpAccountAddress = overheadPda;
    console.log(`Overhead IGP account: ${overheadIgpAccountAddress}`);

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
    if (solana) {
      await solana.stop();
    }
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

      console.log(JSON.stringify(token, null, 2));

      expect(token.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(token.config.type).to.equal('native');
      expect(token.config.owner).to.equal(signer.address);
      expect(token.config.mailbox).to.equal(mailboxAddress);
    });

    it('should deploy with IGP configured and read it back', async () => {
      const writer = new SvmNativeTokenWriter(
        rpc,
        signer,
        programBytes,
        igpProgramId,
      );

      const config = {
        type: 'native' as const,
        owner: signer.address,
        mailbox: mailboxAddress,
        remoteRouters: {},
        destinationGas: {},
        hook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: overheadIgpAccountAddress },
        },
      };

      const [deployed] = await writer.create({ config });

      const reader = new SvmNativeTokenReader(rpc);
      const token = await reader.read(deployed.deployed.address);

      expect(token.config.hook).to.exist;
      expect(token.config.hook?.deployed?.address).to.equal(
        overheadIgpAccountAddress,
      );
    });

    it('should update IGP via update()', async () => {
      // Deploy without IGP first
      const writerNoIgp = new SvmNativeTokenWriter(rpc, signer, programBytes);
      const [deployed] = await writerNoIgp.create({
        config: {
          type: 'native' as const,
          owner: signer.address,
          mailbox: mailboxAddress,
          remoteRouters: {},
          destinationGas: {},
        },
      });

      const reader = new SvmNativeTokenReader(rpc);
      const current = await reader.read(deployed.deployed.address);
      expect(current.config.hook).to.be.undefined;

      // Update to set IGP
      const writerWithIgp = new SvmNativeTokenWriter(
        rpc,
        signer,
        programBytes,
        igpProgramId,
      );
      const updateTxs = await writerWithIgp.update({
        artifactState: ArtifactState.DEPLOYED,
        config: {
          ...current.config,
          hook: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: overheadIgpAccountAddress },
          },
        },
        deployed: deployed.deployed,
      });

      expect(updateTxs.length).to.be.greaterThan(0);
      for (const tx of updateTxs) {
        for (const ix of tx.instructions) {
          await signer.signAndSend(rpc, { instructions: [ix] });
        }
      }

      const updated = await reader.read(deployed.deployed.address);
      expect(updated.config.hook?.deployed?.address).to.equal(
        overheadIgpAccountAddress,
      );
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
          const sig = await signer.signAndSend(rpc, { instructions: [ix] });

          console.log('UPDATE TX SIGNATURE', sig.signature);
        }
      }

      const updated = await reader.read(deployedProgramId);

      console.log(JSON.stringify(updated, null, 2));

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
      console.log(JSON.stringify(current, null, 2));

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

      console.log(JSON.stringify(updated, null, 2));
      expect(updated.config.remoteRouters[1]).to.exist;
      expect(updated.config.remoteRouters[2]).to.be.undefined;
    });
  });
});
