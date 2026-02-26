import { address, type Address } from '@solana/kit';
import { expect } from 'chai';
import { after, before, describe, it } from 'mocha';

import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { TokenType } from '@hyperlane-xyz/provider-sdk/warp';

import {
  DEFAULT_IGP_CONTEXT,
  SvmIgpHookWriter,
  deriveIgpSalt,
  type SvmIgpHookConfig,
} from '../hook/igp-hook.js';
import { SvmTestIsmWriter, type SvmTestIsmConfig } from '../ism/test-ism.js';
import { deriveAtaPayerPda, deriveOverheadIgpAccountPda } from '../pda.js';
import { createRpc } from '../rpc.js';
import { createSigner, type SvmSigner } from '../signer.js';
import {
  PROGRAM_BINARIES,
  TEST_ATA_PAYER_FUNDING_AMOUNT,
  TEST_PROGRAM_IDS,
  airdropSol,
  getPreloadedPrograms,
} from '../testing/setup.js';
import {
  startSolanaTestValidator,
  waitForRpcReady,
  type SolanaTestValidator,
} from '../testing/solana-container.js';
import { SvmSyntheticTokenWriter } from '../warp/synthetic-token.js';

import { defineWarpTokenTests } from './warp-token-suite.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

const PRELOADED_PROGRAMS: Array<keyof typeof PROGRAM_BINARIES> = [
  'mailbox',
  'igp',
  'testIsm',
];

describe('SVM Synthetic Warp Token E2E Tests', function () {
  this.timeout(300_000);

  let solana: SolanaTestValidator;
  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner & { address: Address };
  let mailboxAddress: Address;
  let igpProgramId: Address;
  let overheadIgpAccountAddress: Address;
  let testIsmAddress: Address;
  let writer: SvmSyntheticTokenWriter;

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

    writer = new SvmSyntheticTokenWriter(
      {
        program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenSynthetic },
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

  describe('Synthetic Token', () => {
    let deployedProgramId: string;

    defineWarpTokenTests(
      () => ({
        writer,
        makeConfig: (overrides = {}) => ({
          type: TokenType.synthetic,
          owner: signer.address,
          mailbox: mailboxAddress,
          name: 'Test Token',
          symbol: 'TEST',
          decimals: 6,
          metadataUri: 'https://test.example.com/metadata.json',
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

    it('should have correct metadata after deploy', async () => {
      const token = await writer.read(deployedProgramId);
      expect(token.config.name).to.equal('Test Token');
      expect(token.config.symbol).to.equal('TEST');
      expect(token.config.decimals).to.equal(6);
      expect(token.config.metadataUri).to.equal(
        'https://test.example.com/metadata.json',
      );
      expect(token.config.mailbox).to.equal(mailboxAddress);
    });
  });
});
