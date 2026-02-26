import { address, type Address } from '@solana/kit';
import { after, before, describe, it } from 'mocha';
import { expect } from 'chai';

import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';

import {
  DEFAULT_IGP_CONTEXT,
  SvmIgpHookWriter,
  deriveIgpSalt,
  type SvmIgpHookConfig,
} from '../hook/igp-hook.js';
import { SvmTestIsmWriter, type SvmTestIsmConfig } from '../ism/test-ism.js';
import { deriveAtaPayerPda, deriveOverheadIgpAccountPda } from '../pda.js';
import { createRpc } from '../rpc.js';
import { type SvmSigner, createSigner } from '../signer.js';
import {
  PROGRAM_BINARIES,
  TEST_ATA_PAYER_FUNDING_AMOUNT,
  TEST_PROGRAM_IDS,
  airdropSol,
  createSplMint,
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

const PRELOADED_PROGRAMS: Array<keyof typeof PROGRAM_BINARIES> = [
  'mailbox',
  'igp',
  'testIsm',
];

describe('SVM Collateral Warp Token E2E Tests', function () {
  this.timeout(300_000);

  let solana: SolanaTestValidator;
  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner & { address: Address };
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
    signer = await createSigner(TEST_PRIVATE_KEY, rpc);
    await airdropSol(rpc, signer.address, 50_000_000_000n);

    mailboxAddress = TEST_PROGRAM_IDS.mailbox;
    igpProgramId = TEST_PROGRAM_IDS.igp;

    const igpSalt = deriveIgpSalt(DEFAULT_IGP_CONTEXT);
    const igpConfig: SvmIgpHookConfig = {
      type: 'interchainGasPaymaster',
      owner: signer.address,
      beneficiary: signer.address,
      oracleKey: signer.address,
      overhead: { 1: 50000 },
      oracleConfig: {
        1: { gasPrice: '1', tokenExchangeRate: '1000000000000000000' },
      },
      program: { programId: igpProgramId },
    };
    const igpWriter = new SvmIgpHookWriter(rpc, igpSalt, signer);
    await igpWriter.create({
      artifactState: ArtifactState.NEW,
      config: igpConfig,
    });

    const { address: overheadIgpPda } = await deriveOverheadIgpAccountPda(
      igpProgramId,
      igpSalt,
    );
    overheadIgpAccountAddress = overheadIgpPda;

    testIsmAddress = TEST_PROGRAM_IDS.testIsm;
    const ismConfig: SvmTestIsmConfig = {
      type: 'testIsm',
      program: { programId: testIsmAddress },
    };
    const ismWriter = new SvmTestIsmWriter(rpc, signer);
    await ismWriter.create({
      artifactState: ArtifactState.NEW,
      config: ismConfig,
    });

    // Create a collateral SPL mint for the test.
    collateralMint = await createSplMint(rpc, signer, 9);

    writer = new SvmCollateralTokenWriter(
      {
        program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenCollateral },
        igpProgramId,
        ataPayerFundingAmount: TEST_ATA_PAYER_FUNDING_AMOUNT,
      },
      rpc,
      signer,
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
        makeConfig: (overrides = {}) => ({
          type: 'collateral' as const,
          owner: signer.address,
          mailbox: mailboxAddress,
          token: collateralMint,
          remoteRouters: {},
          destinationGas: {},
          ...overrides,
        }),
        overheadIgpAccountAddress,
        testIsmAddress,
        signer,
        rpc,
      }),
      (id) => {
        deployedProgramId = id;
      },
    );

    it('should fund ATA payer PDA after deploy', async () => {
      const { address: ataPayerPda } = await deriveAtaPayerPda(
        address(deployedProgramId),
      );
      const balance = await rpc.getBalance(ataPayerPda).send();
      expect(BigInt(balance.value) >= TEST_ATA_PAYER_FUNDING_AMOUNT).to.be.true;
    });

    it('should have correct collateral token address after deploy', async () => {
      const token = await writer.read(deployedProgramId);
      expect(token.config.token).to.equal(collateralMint);
      expect(token.config.mailbox).to.equal(mailboxAddress);
    });
  });
});
