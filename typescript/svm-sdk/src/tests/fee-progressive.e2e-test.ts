import { address } from '@solana/kit';
import { before, describe } from 'mocha';

import {
  FeeParamsType,
  FeeType,
  type ProgressiveFeeConfig,
} from '@hyperlane-xyz/provider-sdk/fee';

import { SvmSigner } from '../clients/signer.js';
import {
  SvmProgressiveFeeReader,
  SvmProgressiveFeeWriter,
} from '../fee/progressive-fee.js';
import { DEFAULT_FEE_SALT } from '../fee/types.js';
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

describe('SVM Progressive Fee E2E Tests', function () {
  this.timeout(180_000);

  let ctx: LeafFeeTestContext<ProgressiveFeeConfig>;

  before(async () => {
    const rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    const signer = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      TEST_PRIVATE_KEY,
    );
    await airdropSol(rpc, address(signer.getSignerAddress()), 100_000_000_000n);

    ctx = {
      writer: new SvmProgressiveFeeWriter(
        { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenFee } },
        rpc,
        1,
        signer,
        DEFAULT_FEE_SALT,
      ),
      reader: new SvmProgressiveFeeReader(rpc, DEFAULT_FEE_SALT),
      signer,
      rpc,
      makeConfig: (overrides) => ({
        type: FeeType.progressive,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        params: {
          type: FeeParamsType.raw,
          maxFee: '3000000',
          halfAmount: '1500000',
        },
        ...overrides,
      }),
    };
  });

  defineLeafFeeTests(() => ctx);
});
