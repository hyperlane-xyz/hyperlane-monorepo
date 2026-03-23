import { address, type Address } from '@solana/kit';
import { after, before, describe } from 'mocha';

import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { TokenType } from '@hyperlane-xyz/provider-sdk/warp';

import { SvmSigner } from '../clients/signer.js';
import {
  DEFAULT_IGP_SALT,
  SvmIgpHookWriter,
  type SvmIgpHookConfig,
} from '../hook/igp-hook.js';
import { SvmTestIsmWriter, type SvmTestIsmConfig } from '../ism/test-ism.js';

import { createRpc } from '../rpc.js';
import {
  type PreloadableProgram,
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
import { SvmNativeTokenWriter } from '../warp/native-token.js';

import { defineWarpTokenTests } from './warp-token-suite.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

const PRELOADED_PROGRAMS: Array<PreloadableProgram> = [
  'mailbox',
  'igp',
  'testIsm',
];

describe('SVM Native Warp Token E2E Tests', function () {
  this.timeout(300_000);

  let solana: SolanaTestValidator;
  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let mailboxAddress: Address;
  let igpProgramId: Address;
  let testIsmAddress: Address;
  let writer: SvmNativeTokenWriter;

  before(async () => {
    const preloadedPrograms = getPreloadedPrograms(PRELOADED_PROGRAMS);
    solana = await startSolanaTestValidator({ preloadedPrograms });
    await waitForRpcReady(solana.rpcUrl);

    rpc = createRpc(solana.rpcUrl);
    signer = await SvmSigner.connectWithSigner(
      [solana.rpcUrl],
      TEST_PRIVATE_KEY,
    );
    await airdropSol(rpc, address(signer.getSignerAddress()), 50_000_000_000n);

    mailboxAddress = TEST_PROGRAM_IDS.mailbox;
    igpProgramId = TEST_PROGRAM_IDS.igp;

    const igpConfig: SvmIgpHookConfig = {
      type: 'interchainGasPaymaster',
      owner: signer.getSignerAddress(),
      beneficiary: signer.getSignerAddress(),
      oracleKey: signer.getSignerAddress(),
      overhead: { 1: 50000 },
      oracleConfig: {
        1: { gasPrice: '1', tokenExchangeRate: '1000000000000000000' },
      },
      program: { programId: igpProgramId },
    };
    const igpWriter = new SvmIgpHookWriter(rpc, DEFAULT_IGP_SALT, signer);
    await igpWriter.create({
      artifactState: ArtifactState.NEW,
      config: igpConfig,
    });

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

    writer = new SvmNativeTokenWriter(
      {
        program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenNative },
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

  describe('Native Token', () => {
    defineWarpTokenTests(
      () => ({
        writer,
        makeConfig: (overrides = {}) => ({
          type: TokenType.native,
          owner: signer.getSignerAddress(),
          mailbox: mailboxAddress,
          remoteRouters: {},
          destinationGas: {},
          ...overrides,
        }),
        igpProgramId,
        testIsmAddress,
        signer,
        rpc,
        rpcUrl: solana.rpcUrl,
      }),
      (_id) => {},
    );
  });
});
