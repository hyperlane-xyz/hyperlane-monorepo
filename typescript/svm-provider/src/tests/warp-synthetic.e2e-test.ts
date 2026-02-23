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
  SvmSyntheticTokenReader,
  SvmSyntheticTokenWriter,
} from '../warp/synthetic-token.js';
// eslint-disable-next-line import/no-nodejs-modules
import * as fs from 'fs/promises';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

const PRELOADED_PROGRAMS: Array<
  keyof typeof import('../testing/setup.js').PROGRAM_BINARIES
> = ['mailbox', 'igp'];

describe('SVM Synthetic Warp Token E2E Tests', function () {
  this.timeout(300_000);

  let solana: SolanaTestValidator;
  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let programBytes: Uint8Array;
  let mailboxAddress: Address;
  let igpProgramId: Address;
  let overheadIgpAccountAddress: Address;

  before(async () => {
    const preloadedPrograms = getPreloadedPrograms(PRELOADED_PROGRAMS);
    console.log('Starting validator with mailbox + igp...');
    solana = await startSolanaTestValidator({ preloadedPrograms });
    await waitForRpcReady(solana.rpcUrl);

    rpc = createRpc(solana.rpcUrl);
    signer = await createSigner(TEST_PRIVATE_KEY);
    await airdropSol(rpc, signer.address, 50_000_000_000n); // 50 SOL — multiple program deployments per test

    mailboxAddress = TEST_PROGRAM_IDS.mailbox;
    igpProgramId = TEST_PROGRAM_IDS.igp;
    console.log(`Mailbox: ${mailboxAddress}`);
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

    const programPath = path.join(
      DEFAULT_PROGRAMS_PATH,
      'hyperlane_sealevel_token.so',
    );
    programBytes = new Uint8Array(await fs.readFile(programPath));
    console.log(`Loaded synthetic program: ${programBytes.length} bytes`);
  });

  after(async () => {
    if (solana) {
      await solana.stop();
    }
  });

  describe('Synthetic Token', () => {
    let deployedProgramId: string;

    it('should deploy and initialize synthetic token', async () => {
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
        decimals: token.config.decimals,
      });
      expect(token.config.name).to.equal('Test Token');
      expect(token.config.symbol).to.equal('TEST');
      expect(token.config.decimals).to.equal(token.config.decimals);
    });

    it('should deploy with IGP configured and read it back', async () => {
      const writer = new SvmSyntheticTokenWriter(
        rpc,
        signer,
        programBytes,
        solana.rpcUrl,
        igpProgramId,
      );

      const config = {
        type: 'synthetic' as const,
        owner: signer.address,
        mailbox: mailboxAddress,
        remoteRouters: {},
        destinationGas: {},
        name: 'IGP Token',
        symbol: 'IGPT',
        decimals: 6,
        hook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: overheadIgpAccountAddress },
        },
      };

      const [deployed] = await writer.create({ config });

      const reader = new SvmSyntheticTokenReader(rpc, solana.rpcUrl);
      const token = await reader.read(deployed.deployed.address);

      expect(token.config.hook).to.exist;
      expect(token.config.hook?.deployed?.address).to.equal(
        overheadIgpAccountAddress,
      );
    });

    it('should update IGP via update()', async () => {
      // Deploy without IGP first
      const writerNoIgp = new SvmSyntheticTokenWriter(
        rpc,
        signer,
        programBytes,
        solana.rpcUrl,
      );
      const [deployed] = await writerNoIgp.create({
        config: {
          type: 'synthetic' as const,
          owner: signer.address,
          mailbox: mailboxAddress,
          remoteRouters: {},
          destinationGas: {},
          name: 'Update IGP Token',
          symbol: 'UIGPT',
          decimals: 6,
        },
      });

      const reader = new SvmSyntheticTokenReader(rpc, solana.rpcUrl);
      const current = await reader.read(deployed.deployed.address);
      expect(current.config.hook).to.be.undefined;

      // Update to set IGP
      const writerWithIgp = new SvmSyntheticTokenWriter(
        rpc,
        signer,
        programBytes,
        solana.rpcUrl,
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
