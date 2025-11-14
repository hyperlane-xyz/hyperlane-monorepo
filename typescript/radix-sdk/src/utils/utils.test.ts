import { InstructionsKind } from '@radixdlt/radix-engine-toolkit';
import { expect } from 'chai';

import { addressToBytes32, assert, strip0x } from '@hyperlane-xyz/utils';

import { getTransferRemoteManifest } from '../warp/populate.js';

import { stringToTransactionManifest } from './utils.js';

describe(stringToTransactionManifest.name, function () {
  it('should convert a string manifest to an object manifest', async function () {
    const stringManifest = getTransferRemoteManifest({
      destination_domain: 1,
      from_address:
        'account_rdx12yfx5atksn0ctreywz9l72j25a90nxp0et2ufhf6hf0rd57vxfwtwk',
      max_fee: {
        amount: '1',
        denom:
          'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd',
      },
      origin_denom:
        'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd',
      recipient: strip0x(
        addressToBytes32('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'),
      ),
      token:
        'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd',
      tokenAmount: '1',
    });

    const res = await stringToTransactionManifest(stringManifest, 1);

    expect(res.instructions.kind).to.eq(InstructionsKind.Parsed);
    expect(res.instructions.value).to.be.an('array');

    assert(
      res.instructions.kind === InstructionsKind.Parsed,
      `Expected instruction to be of kind ${InstructionsKind.Parsed}`,
    );
    expect(res.instructions.value).to.have.length.greaterThan(0);
  });
});
