import type { Address } from '@solana/kit';
import { createMint } from '@solana/spl-token';
import { Connection, Keypair } from '@solana/web3.js';
import { expect } from 'chai';
import { after, before, describe, it } from 'mocha';

import { HookType } from '@hyperlane-xyz/provider-sdk/altvm';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import type { RawCollateralWarpArtifactConfig } from '@hyperlane-xyz/provider-sdk/warp';

import { PROGRAM_BYTES } from '../generated/program-bytes.js';
import { SvmIgpHookWriter, deriveIgpSalt } from '../hook/igp-hook.js';
import { SvmTestIsmWriter } from '../ism/test-ism.js';
import { getOverheadIgpAccountPda } from '../pda.js';
import { createRpc } from '../rpc.js';
import { type SvmSigner, createSigner } from '../signer.js';
import {
  TEST_PROGRAM_IDS,
  airdropSol,
  getPreloadedPrograms,
} from '../testing/setup.js';
import {
  type SolanaTestValidator,
  startSolanaTestValidator,
  waitForRpcReady,
} from '../testing/solana-container.js';
import { SvmCollateralTokenWriter } from '../warp/collateral-token.js';

import { defineWarpTokenTests } from './warp-token-suite.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

const PRELOADED_PROGRAMS: Array<
  keyof typeof import('../testing/setup.js').PROGRAM_BINARIES
> = ['mailbox', 'igp', 'testIsm'];

describe('SVM Collateral Warp Token E2E Tests', function () {
  this.timeout(300_000);

  let solana: SolanaTestValidator;
  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let mailboxAddress: Address;
  let collateralMint: Address;
  let igpProgramId: Address;
  let overheadIgpAccountAddress: Address;
  let testIsmAddress: Address;
  let writer: SvmCollateralTokenWriter;

  before(async () => {
    const preloadedPrograms = getPreloadedPrograms(PRELOADED_PROGRAMS);
    solana = await startSolanaTestValidator({ preloadedPrograms });
    await waitForRpcReady(solana.rpcUrl);

    rpc = createRpc(solana.rpcUrl);
    signer = await createSigner(TEST_PRIVATE_KEY);
    await airdropSol(rpc, signer.address, 50_000_000_000n);

    mailboxAddress = TEST_PROGRAM_IDS.mailbox;
    igpProgramId = TEST_PROGRAM_IDS.igp;

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

    testIsmAddress = TEST_PROGRAM_IDS.testIsm;
    const ismWriter = new SvmTestIsmWriter(rpc, testIsmAddress, signer);
    await ismWriter.create({
      artifactState: ArtifactState.NEW,
      config: { type: 'testIsm' },
    });

    const connection = new Connection(solana.rpcUrl, 'confirmed');
    const seed = Buffer.from(TEST_PRIVATE_KEY.slice(2), 'hex');
    const payer = Keypair.fromSeed(seed);
    const mint = await createMint(connection, payer, payer.publicKey, null, 9);
    collateralMint = mint.toBase58() as Address;

    writer = new SvmCollateralTokenWriter(
      { igpProgramId, programBytes: PROGRAM_BYTES.collateralToken },
      rpc,
      signer,
      solana.rpcUrl,
    );
  });

  after(async () => {
    if (solana) {
      await solana.stop();
    }
  });

  describe('Collateral Token', () => {
    let deployedProgramId: string;

    defineWarpTokenTests(
      () => ({
        writer,
        makeConfig: (overrides = {}) =>
          ({
            type: 'collateral' as const,
            owner: signer.address,
            mailbox: mailboxAddress,
            token: collateralMint,
            remoteRouters: {},
            destinationGas: {},
            ...overrides,
          }) as RawCollateralWarpArtifactConfig,
        overheadIgpAccountAddress,
        testIsmAddress,
        signer,
        rpc,
      }),
      (id) => {
        deployedProgramId = id;
      },
    );

    it('should have correct collateral token address after deploy', async () => {
      const token = await writer.read(deployedProgramId);
      expect(token.config.token).to.equal(collateralMint);
      expect(token.config.mailbox).to.equal(mailboxAddress);
    });
  });
});
