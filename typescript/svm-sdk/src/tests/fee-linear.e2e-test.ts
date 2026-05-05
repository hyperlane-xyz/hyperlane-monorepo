import { address } from '@solana/kit';
import { before, describe } from 'mocha';

import {
  FeeParamsType,
  FeeType,
  type LinearFeeConfig,
} from '@hyperlane-xyz/provider-sdk/fee';

import { SvmSigner } from '../clients/signer.js';
import { SvmLinearFeeReader, SvmLinearFeeWriter } from '../fee/linear-fee.js';
import { DEFAULT_FEE_SALT, type SvmFeeWriterConfig } from '../fee/types.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { airdropSol } from '../testing/setup.js';
import {
  defineLeafFeeTests,
  type LeafFeeTestContext,
} from './fee-leaf-suite.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

describe('SVM Linear Fee E2E Tests', function () {
  this.timeout(180_000);

  let ctx: LeafFeeTestContext<LinearFeeConfig>;

  before(async () => {
    const rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    const signer = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      TEST_PRIVATE_KEY,
    );
    await airdropSol(rpc, address(signer.getSignerAddress()), 100_000_000_000n);

    const writerConfig: SvmFeeWriterConfig = {
      program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenFee },
    };

    ctx = {
      writer: new SvmLinearFeeWriter(
        writerConfig,
        rpc,
        1,
        signer,
        DEFAULT_FEE_SALT,
      ),
      reader: new SvmLinearFeeReader(rpc, DEFAULT_FEE_SALT),
      signer,
      rpc,
      rpcUrl: TEST_SVM_CHAIN_METADATA.rpcUrl,
      makeWriter: (s) =>
        new SvmLinearFeeWriter(writerConfig, rpc, 1, s, DEFAULT_FEE_SALT),
      makeConfig: (overrides) => ({
        type: FeeType.linear,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        params: {
          type: FeeParamsType.raw,
          maxFee: '1000000',
          halfAmount: '500000',
        },
        ...overrides,
      }),
    };
  });

  defineLeafFeeTests(() => ctx);
});
