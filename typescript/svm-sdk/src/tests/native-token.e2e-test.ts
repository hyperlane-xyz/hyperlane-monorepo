import { address, type Address } from '@solana/kit';
import { before, describe } from 'mocha';

import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { TokenType } from '@hyperlane-xyz/provider-sdk/warp';

import { SvmSigner } from '../clients/signer.js';
import {
  DEFAULT_IGP_SALT,
  SvmIgpHookWriter,
  type SvmIgpHookConfig,
} from '../hook/igp-hook.js';
import { SvmTestIsmWriter } from '../ism/test-ism.js';

import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import {
  TEST_ATA_PAYER_FUNDING_AMOUNT,
  TEST_PROGRAM_IDS,
  airdropSol,
} from '../testing/setup.js';
import { SvmNativeTokenWriter } from '../warp/native-token.js';

import { defineWarpTokenTests } from './warp-token-suite.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

describe('SVM Native Warp Token E2E Tests', function () {
  this.timeout(300_000);

  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let mailboxAddress: Address;
  let igpProgramId: Address;
  let testIsmAddress: Address;
  let writer: SvmNativeTokenWriter;

  before(async () => {
    rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    signer = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
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
    const ismWriter = new SvmTestIsmWriter(
      { program: { programId: testIsmAddress } },
      rpc,
      signer,
    );
    await ismWriter.create({
      artifactState: ArtifactState.NEW,
      config: { type: 'testIsm' },
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
        rpcUrl: TEST_SVM_CHAIN_METADATA.rpcUrl,
      }),
      (_id) => {},
    );
  });
});
