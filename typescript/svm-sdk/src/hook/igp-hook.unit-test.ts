import { type Address, address as parseAddress } from '@solana/kit';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { describe, it } from 'mocha';

chai.use(chaiAsPromised);

import type { IgpFeeConfig } from '../codecs/igp.js';

import { computeIgpFeeConfigUpdate } from './igp-hook.js';

const PROGRAM_ID: Address = parseAddress(
  'GZGLpeuMaUXUmBHh1EtgWQDufyUoHapAKFfgKb6u8o3h',
);
const IGP_PDA: Address = parseAddress(
  'EALSQwzJFwRbjDjBkwNziHXnowfgwt9ixKapKiudGa45',
);
const OWNER: Address = parseAddress(
  '2nss3sLwiUCP98rXQ6FciJ35cDeSLu3VEU5mFRa7p43J',
);
const DOMAIN_ID = 137;
const SUPPORTED_VERSION = '1.0.0';

const SIGNER_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SIGNER_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SIGNER_C = '0xcccccccccccccccccccccccccccccccccccccccc';

function call(args: {
  expectedQuoteSigners?: string[];
  currentFeeConfig?: IgpFeeConfig;
  effectiveContractVersion?: string;
  domainId?: number;
}) {
  return computeIgpFeeConfigUpdate({
    programId: PROGRAM_ID,
    igpPda: IGP_PDA,
    ownerAddress: OWNER,
    domainId: args.domainId ?? DOMAIN_ID,
    expectedQuoteSigners: args.expectedQuoteSigners,
    currentFeeConfig: args.currentFeeConfig,
    effectiveContractVersion:
      args.effectiveContractVersion ?? SUPPORTED_VERSION,
  });
}

const annotations = (txs: { annotation?: string }[]) =>
  txs.map((t) => t.annotation ?? '');

describe('computeIgpFeeConfigUpdate', () => {
  it('returns no txs when both expected and current are undefined', async () => {
    const txs = await call({});
    expect(txs).to.have.length(0);
  });

  it('leaves on-chain fee_config alone when expected is undefined and current is set', async () => {
    const txs = await call({
      currentFeeConfig: {
        signers: [SIGNER_A],
        domainId: DOMAIN_ID,
        minIssuedAt: 0n,
      },
    });
    expect(txs).to.have.length(0);
  });

  it('initializes empty fee_config when expected is [] and current is undefined', async () => {
    const txs = await call({ expectedQuoteSigners: [] });
    expect(annotations(txs)).to.eql([`Init IGP fee config for ${PROGRAM_ID}`]);
  });

  it('initializes + adds each signer when expected has signers and current is undefined', async () => {
    const txs = await call({ expectedQuoteSigners: [SIGNER_A, SIGNER_B] });
    expect(annotations(txs)).to.eql([
      `Init IGP fee config for ${PROGRAM_ID}`,
      `Add IGP quote signer ${SIGNER_A}`,
      `Add IGP quote signer ${SIGNER_B}`,
    ]);
  });

  it('removes all signers when expected is [] and current has signers', async () => {
    const txs = await call({
      expectedQuoteSigners: [],
      currentFeeConfig: {
        signers: [SIGNER_A, SIGNER_B],
        domainId: DOMAIN_ID,
        minIssuedAt: 0n,
      },
    });
    expect(annotations(txs)).to.eql([
      `Remove IGP quote signer ${SIGNER_A}`,
      `Remove IGP quote signer ${SIGNER_B}`,
    ]);
  });

  it('returns no txs when expected and current signer sets match (case-insensitive)', async () => {
    const txs = await call({
      expectedQuoteSigners: [SIGNER_A.toUpperCase(), SIGNER_B],
      currentFeeConfig: {
        signers: [SIGNER_A, SIGNER_B],
        domainId: DOMAIN_ID,
        minIssuedAt: 0n,
      },
    });
    expect(txs).to.have.length(0);
  });

  it('emits Add + Remove deltas when signer sets differ', async () => {
    const txs = await call({
      expectedQuoteSigners: [SIGNER_A, SIGNER_C],
      currentFeeConfig: {
        signers: [SIGNER_A, SIGNER_B],
        domainId: DOMAIN_ID,
        minIssuedAt: 0n,
      },
    });
    expect(annotations(txs)).to.eql([
      `Remove IGP quote signer ${SIGNER_B}`,
      `Add IGP quote signer ${SIGNER_C}`,
    ]);
  });

  it('throws when on-chain domainId differs from configured', async () => {
    await expect(
      call({
        expectedQuoteSigners: [SIGNER_A],
        currentFeeConfig: {
          signers: [SIGNER_A],
          domainId: DOMAIN_ID + 1,
          minIssuedAt: 0n,
        },
      }),
    ).to.be.rejectedWith(/fee_config domain mismatch/);
  });

  it('throws when expected is set but program version does not support fee config', async () => {
    await expect(
      call({
        expectedQuoteSigners: [SIGNER_A],
        effectiveContractVersion: '0.1.0',
      }),
    ).to.be.rejectedWith(/does not support fee config/);
  });
});
