import type { Address } from '@solana/kit';
import { after, before, describe } from 'mocha';

import { HookType } from '@hyperlane-xyz/provider-sdk/altvm';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import type { RawNativeWarpArtifactConfig } from '@hyperlane-xyz/provider-sdk/warp';

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
import { SvmNativeTokenWriter } from '../warp/native-token.js';

import { defineWarpTokenTests } from './warp-token-suite.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

const PRELOADED_PROGRAMS: Array<
  keyof typeof import('../testing/setup.js').PROGRAM_BINARIES
> = ['mailbox', 'igp', 'testIsm'];

describe('SVM Native Warp Token E2E Tests', function () {
  this.timeout(300_000);

  let solana: SolanaTestValidator;
  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let mailboxAddress: Address;
  let igpProgramId: Address;
  let overheadIgpAccountAddress: Address;
  let testIsmAddress: Address;
  let writer: SvmNativeTokenWriter;

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
        type: HookType.INTERCHAIN_GAS_PAYMASTER,
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

    writer = new SvmNativeTokenWriter(
      { igpProgramId, programBytes: PROGRAM_BYTES.nativeToken },
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
        makeConfig: (overrides = {}) =>
          ({
            type: 'native' as const,
            owner: signer.address,
            mailbox: mailboxAddress,
            remoteRouters: {},
            destinationGas: {},
            ...overrides,
          }) as RawNativeWarpArtifactConfig,
        overheadIgpAccountAddress,
        testIsmAddress,
        signer,
        rpc,
      }),
      (_id) => {},
    );
  });
});
