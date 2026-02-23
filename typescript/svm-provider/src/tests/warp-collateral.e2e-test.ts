import type { Address } from '@solana/kit';
import { createMint } from '@solana/spl-token';
import { Connection, Keypair } from '@solana/web3.js';
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
  SvmCollateralTokenReader,
  SvmCollateralTokenWriter,
} from '../warp/collateral-token.js';
// eslint-disable-next-line import/no-nodejs-modules
import * as fs from 'fs/promises';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

const PRELOADED_PROGRAMS: Array<
  keyof typeof import('../testing/setup.js').PROGRAM_BINARIES
> = ['mailbox', 'igp'];

describe('SVM Collateral Warp Token E2E Tests', function () {
  this.timeout(300_000);

  let solana: SolanaTestValidator;
  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let programBytes: Uint8Array;
  let mailboxAddress: Address;
  let collateralMint: Address;
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

    // Create a test SPL token to use as collateral
    console.log('Creating test SPL token for collateral...');
    const connection = new Connection(solana.rpcUrl, 'confirmed');

    // Generate keypair from seed (TEST_PRIVATE_KEY is 32-byte seed)
    const seed = Buffer.from(TEST_PRIVATE_KEY.slice(2), 'hex');
    const payer = Keypair.fromSeed(seed);

    const mint = await createMint(
      connection,
      payer,
      payer.publicKey,
      null,
      9, // 9 decimals
    );
    collateralMint = mint.toBase58() as Address;
    console.log(`Collateral mint created: ${collateralMint}`);

    const programPath = path.join(
      DEFAULT_PROGRAMS_PATH,
      'hyperlane_sealevel_token_collateral.so',
    );
    programBytes = new Uint8Array(await fs.readFile(programPath));
    console.log(`Loaded collateral program: ${programBytes.length} bytes`);
  });

  after(async () => {
    console.log('\n=== Validator kept running ===');
    console.log(`RPC: ${solana.rpcUrl}`);
    // if (solana) {
    //   await solana.stop();
    // }
  });

  describe('Collateral Token', () => {
    let deployedProgramId: string;

    it('should deploy and initialize collateral token', async () => {
      const writer = new SvmCollateralTokenWriter(
        rpc,
        signer,
        programBytes,
        solana.rpcUrl,
      );

      const config = {
        type: 'collateral' as const,
        owner: signer.address,
        mailbox: mailboxAddress,
        token: collateralMint, // Use the SPL token we created
        remoteRouters: {},
        destinationGas: {},
      };

      console.log('Creating collateral token...');
      const [deployed, receipts] = await writer.create({ config });

      deployedProgramId = deployed.deployed.address;
      console.log(`Deployed: ${deployedProgramId}`);
      console.log(`Receipts: ${receipts.length}`);

      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(deployed.config.type).to.equal('collateral');
      expect(deployed.config.token).to.equal(collateralMint);
      expect(receipts.length).to.be.greaterThan(0);
    });

    it('should read collateral token config', async () => {
      const reader = new SvmCollateralTokenReader(rpc, solana.rpcUrl);
      const token = await reader.read(deployedProgramId);

      expect(token.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(token.config.type).to.equal('collateral');
      expect(token.config.token).to.equal(collateralMint);
      expect(token.config.mailbox).to.equal(mailboxAddress);
    });

    it('should deploy with IGP configured and read it back', async () => {
      const writer = new SvmCollateralTokenWriter(
        rpc,
        signer,
        programBytes,
        solana.rpcUrl,
        igpProgramId,
      );

      const config = {
        type: 'collateral' as const,
        owner: signer.address,
        mailbox: mailboxAddress,
        token: collateralMint,
        remoteRouters: {},
        destinationGas: {},
        hook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: overheadIgpAccountAddress },
        },
      };

      const [deployed] = await writer.create({ config });

      const reader = new SvmCollateralTokenReader(rpc, solana.rpcUrl);
      const token = await reader.read(deployed.deployed.address);

      expect(token.config.hook).to.exist;
      expect(token.config.hook?.deployed?.address).to.equal(
        overheadIgpAccountAddress,
      );
    });

    it('should update IGP via update()', async () => {
      // Deploy without IGP first
      const writerNoIgp = new SvmCollateralTokenWriter(
        rpc,
        signer,
        programBytes,
        solana.rpcUrl,
      );
      const [deployed] = await writerNoIgp.create({
        config: {
          type: 'collateral' as const,
          owner: signer.address,
          mailbox: mailboxAddress,
          token: collateralMint,
          remoteRouters: {},
          destinationGas: {},
        },
      });

      const reader = new SvmCollateralTokenReader(rpc, solana.rpcUrl);
      const current = await reader.read(deployed.deployed.address);
      expect(current.config.hook).to.be.undefined;

      // Now update to set IGP
      const writerWithIgp = new SvmCollateralTokenWriter(
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
      const reader = new SvmCollateralTokenReader(rpc, solana.rpcUrl);
      const writer = new SvmCollateralTokenWriter(
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
    });
  });
});
