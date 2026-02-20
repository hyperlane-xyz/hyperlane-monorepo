import type { Address } from '@solana/kit';
import { createMint } from '@solana/spl-token';
import { Connection, Keypair } from '@solana/web3.js';
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
  SvmCollateralTokenReader,
  SvmCollateralTokenWriter,
} from '../warp/collateral-token.js';
// eslint-disable-next-line import/no-nodejs-modules
import * as fs from 'fs/promises';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

const PRELOADED_PROGRAMS: Array<
  keyof typeof import('../testing/setup.js').PROGRAM_BINARIES
> = ['mailbox'];

describe('SVM Collateral Warp Token E2E Tests', function () {
  this.timeout(300_000);

  let solana: SolanaTestValidator;
  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let programBytes: Uint8Array;
  let mailboxAddress: Address;
  let collateralMint: Address;

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
      const writer = new SvmCollateralTokenWriter(rpc, signer, programBytes);

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
      const reader = new SvmCollateralTokenReader(rpc);
      const token = await reader.read(deployedProgramId);

      expect(token.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(token.config.type).to.equal('collateral');
      expect(token.config.token).to.equal(collateralMint);
      expect(token.config.mailbox).to.equal(mailboxAddress);
    });

    it('should enroll remote routers', async () => {
      const reader = new SvmCollateralTokenReader(rpc);
      const writer = new SvmCollateralTokenWriter(rpc, signer, programBytes);

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
