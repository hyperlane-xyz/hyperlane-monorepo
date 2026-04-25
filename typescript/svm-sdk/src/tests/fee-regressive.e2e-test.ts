import { address } from '@solana/kit';
import { before, describe } from 'mocha';

import { SvmSigner } from '../clients/signer.js';
import {
  SvmRegressiveFeeReader,
  SvmRegressiveFeeWriter,
} from '../fee/regressive-fee.js';
import { DEFAULT_FEE_SALT } from '../fee/types.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { airdropSol } from '../testing/setup.js';
import {
  defineLeafFeeTests,
  type LeafFeeTestContext,
} from './fee-leaf-suite.js';
import { FeeType, FeeParamsKind } from '@hyperlane-xyz/provider-sdk/fee';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

describe('SVM Regressive Fee E2E Tests', function () {
  this.timeout(180_000);

  let ctx: LeafFeeTestContext<typeof FeeType.regressive>;

  before(async () => {
    const rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    const signer = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      TEST_PRIVATE_KEY,
    );
    await airdropSol(rpc, address(signer.getSignerAddress()), 100_000_000_000n);

    const writer = new SvmRegressiveFeeWriter(
      { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenFee } },
      rpc,
      1,
      signer,
      DEFAULT_FEE_SALT,
    );

    ctx = {
      writer,
      reader: new SvmRegressiveFeeReader(rpc, DEFAULT_FEE_SALT),
      signer,
      rpc,
      makeConfig: (overrides) => ({
        type: FeeType.regressive,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        params: {
          kind: FeeParamsKind.raw,
          maxFee: '5000000',
          halfAmount: '2500000',
        },
        ...overrides,
      }),
    };
  });

  defineLeafFeeTests(() => ctx);
});
