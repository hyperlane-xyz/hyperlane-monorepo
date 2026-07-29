import { type Address, address as parseAddress } from '@solana/kit';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { describe, it } from 'mocha';

import {
  ArtifactState,
  type ArtifactDeployed,
} from '@hyperlane-xyz/provider-sdk/artifact';

import type { SvmSigner } from '../clients/signer.js';
import type { SvmRpc } from '../types.js';

import {
  SvmAddressLookupTableWriter,
  type SvmAltConfig,
  type SvmDeployedAlt,
} from './address-lookup-table.js';

chai.use(chaiAsPromised);

const SIGNER = parseAddress('11111111111111111111111111111112');
const ALT_ADDRESS = parseAddress('11111111111111111111111111111113');

function stubRpc(): SvmRpc {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('rpc should not be called before the cap assert fires');
      },
    },
  ) as unknown as SvmRpc;
}

function stubSigner(): SvmSigner {
  return {
    signer: { address: SIGNER },
  } as unknown as SvmSigner;
}

// Generates `count` deterministic distinct base58 addresses by stuffing a
// little-endian counter into the first 4 bytes of an otherwise-zero pubkey.
// Solana addresses are base58(32 bytes), so any 32-byte buffer is a valid
// address — we never sign with these.
function makeAddresses(count: number): Address[] {
  const out: Address[] = [];
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  for (let i = 1; i <= count; i += 1) {
    view.setUint32(0, i, true);
    out.push(parseAddress(base58Encode(bytes)));
  }
  return out;
}

// Minimal base58 encoder — tests only need deterministic distinct outputs.
function base58Encode(bytes: Uint8Array): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = 0n;
  for (const b of bytes) num = (num << 8n) + BigInt(b);
  let s = '';
  while (num > 0n) {
    s = ALPHABET[Number(num % 58n)] + s;
    num /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
}

function deployedAlt(
  current: SvmAltConfig,
): ArtifactDeployed<SvmAltConfig, SvmDeployedAlt> {
  return {
    artifactState: ArtifactState.DEPLOYED,
    config: current,
    deployed: {
      address: ALT_ADDRESS,
      lastExtendedSlot: 0n,
      authority: SIGNER,
    },
  };
}

/** Stub writer whose `read()` returns a fixed on-chain state. */
class StubWriter extends SvmAddressLookupTableWriter {
  constructor(
    private readonly current: ArtifactDeployed<SvmAltConfig, SvmDeployedAlt>,
  ) {
    super(stubRpc(), stubSigner());
  }
  async read(): Promise<ArtifactDeployed<SvmAltConfig, SvmDeployedAlt>> {
    return this.current;
  }
}

describe('SvmAddressLookupTableWriter — 256-address cap', () => {
  describe('create()', () => {
    it('rejects when the deduped address set exceeds 256', async () => {
      const writer = new SvmAddressLookupTableWriter(stubRpc(), stubSigner());
      const addresses = makeAddresses(257);
      await expect(
        writer.create({
          artifactState: ArtifactState.NEW,
          config: { frozen: false, addresses },
        }),
      ).to.be.rejectedWith(/exceeds the 256-address cap \(257\)/);
    });

    it('rejects a frozen config with no addresses', async () => {
      // The SvmAltConfig union forbids this at compile time; JSON-parsed
      // input can still reach create() with the shape, so the runtime
      // guard must fire before any rpc call.
      const config: SvmAltConfig = JSON.parse('{"frozen":true,"addresses":[]}');
      const writer = new SvmAddressLookupTableWriter(stubRpc(), stubSigner());
      await expect(
        writer.create({ artifactState: ArtifactState.NEW, config }),
      ).to.be.rejectedWith(/Cannot create a frozen ALT with no addresses/);
    });

    it('counts deduped addresses, not raw input length', async () => {
      // 300 raw entries but only 50 unique → must pass the cap check.
      // The next step (rpc.getSlot) trips the stubRpc, proving the cap
      // assertion did not fire.
      const unique = makeAddresses(50);
      const writer = new SvmAddressLookupTableWriter(stubRpc(), stubSigner());
      const raw = Array.from({ length: 300 }, (_, i) => unique[i % 50]);
      await expect(
        writer.create({
          artifactState: ArtifactState.NEW,
          config: { frozen: false, addresses: raw },
        }),
      ).to.be.rejectedWith(/rpc should not be called/);
    });
  });

  describe('update()', () => {
    it('rejects when current + new addresses exceed 256', async () => {
      const current = makeAddresses(200);
      const expected = [...current, ...makeAddresses(257).slice(200)];
      const writer = new StubWriter(
        deployedAlt({ frozen: false, addresses: current }),
      );
      await expect(
        writer.update({
          artifactState: ArtifactState.DEPLOYED,
          config: { frozen: false, addresses: expected },
          deployed: {
            address: ALT_ADDRESS,
            lastExtendedSlot: 0n,
            authority: SIGNER,
          },
        }),
      ).to.be.rejectedWith(/would exceed the 256-address cap/);
    });

    it('accepts current + new addresses exactly at 256', async () => {
      const current = makeAddresses(200);
      const expected = makeAddresses(256);
      const writer = new StubWriter(
        deployedAlt({ frozen: false, addresses: current }),
      );
      const txs = await writer.update({
        artifactState: ArtifactState.DEPLOYED,
        config: { frozen: false, addresses: expected },
        deployed: {
          address: ALT_ADDRESS,
          lastExtendedSlot: 0n,
          authority: SIGNER,
        },
      });
      // 56 new addresses → ceil(56 / EXTEND_CHUNK_SIZE=20) = 3 extend txs.
      expect(txs.length).to.equal(3);
    });
  });
});
