import { expect } from 'chai';
import { ethers } from 'ethers';
import sinon from 'sinon';

import type { TurnkeyServerClient } from '@turnkey/sdk-server';

import { TurnkeyClientManager, TurnkeyConfig } from '../turnkeyClient.js';

import {
  TurnkeyEvmSigner,
  normalizeRecoveryV,
  normalizeSignatureComponent,
} from './turnkey.js';

// A Safe SafeTx typed-data payload — the domain/message fields Turnkey policy
// must be able to inspect.
const DOMAIN: ethers.TypedDataDomain = {
  chainId: 1,
  verifyingContract: '0x1234567890123456789012345678901234567890',
};
const TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'nonce', type: 'uint256' },
  ],
};
const MESSAGE = {
  to: '0x000000000000000000000000000000000000dEaD',
  value: '0',
  data: '0xabcd',
  operation: 1,
  nonce: 7,
};

function configFor(publicKey: string): TurnkeyConfig {
  return {
    organizationId: 'org-id',
    apiPublicKey: 'api-public-key',
    apiPrivateKey: 'api-private-key',
    privateKeyId: 'private-key-id',
    publicKey,
  };
}

/**
 * Split a real ECDSA signature into the exact shape Turnkey's `signRawPayload`
 * returns: r/s as bare 32-byte hex (no `0x`) and v as a recovery id "00"/"01"
 * (not the ethers 27/28 form). Mirrors Turnkey's own `splitSignature`.
 */
function toTurnkeyRawResult(signature: string): {
  activity: { status: string };
  r: string;
  s: string;
  v: string;
} {
  const split = ethers.utils.splitSignature(signature);
  return {
    activity: { status: 'ACTIVITY_STATUS_COMPLETED' },
    r: split.r.slice(2),
    s: split.s.slice(2),
    v: split.recoveryParam === 1 ? '01' : '00',
  };
}

describe('TurnkeyEvmSigner._signTypedData', () => {
  let signRawPayload: sinon.SinonStub;

  beforeEach(() => {
    signRawPayload = sinon.stub();
    const fakeClient = { signRawPayload };
    // CAST: test double — TurnkeyServerClient is a large generated client;
    // the signer only calls signRawPayload, which this stub provides.
    sinon
      .stub(TurnkeyClientManager.prototype, 'getClient')
      .returns(fakeClient as unknown as TurnkeyServerClient);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('submits the EIP-712 payload so policy can inspect the message', async () => {
    const wallet = ethers.Wallet.createRandom();
    const realSignature = await wallet._signTypedData(DOMAIN, TYPES, MESSAGE);
    signRawPayload.resolves(toTurnkeyRawResult(realSignature));

    const signer = new TurnkeyEvmSigner(configFor(wallet.address));
    await signer._signTypedData(DOMAIN, TYPES, MESSAGE);

    expect(signRawPayload.calledOnce).to.be.true;
    const arg = signRawPayload.getCall(0).args[0];
    expect(arg.encoding).to.equal('PAYLOAD_ENCODING_EIP712');
    expect(arg.signWith).to.equal(wallet.address);

    // ethers' getPayload canonicalizes the EIP-712 message: addresses are
    // lowercased and numeric fields are stringified.
    const payload = JSON.parse(arg.payload);
    expect(payload.primaryType).to.equal('SafeTx');
    expect(payload.types.EIP712Domain).to.be.an('array');
    expect(payload.message.to).to.equal(MESSAGE.to.toLowerCase());
    expect(payload.message.operation).to.equal(String(MESSAGE.operation));
    expect(payload.message.nonce).to.equal(String(MESSAGE.nonce));
  });

  // Cover both recovery ids. Turnkey hands back v as "00"/"01"; the signer must
  // lift it to ethers' 27/28 space so the assembled signature verifies. Feeding
  // an already-normalized signature (0x-prefixed r/s + v="1b") would mask this.
  for (const recoveryParam of [0, 1] as const) {
    it(`recovers the signer for Turnkey recovery id v=0${recoveryParam}`, async () => {
      // Find a signature with the target recovery id so both branches of the
      // v-normalization run deterministically.
      let wallet = ethers.Wallet.createRandom();
      let realSignature = await wallet._signTypedData(DOMAIN, TYPES, MESSAGE);
      while (
        ethers.utils.splitSignature(realSignature).recoveryParam !==
        recoveryParam
      ) {
        wallet = ethers.Wallet.createRandom();
        realSignature = await wallet._signTypedData(DOMAIN, TYPES, MESSAGE);
      }

      const raw = toTurnkeyRawResult(realSignature);
      expect(raw.r).to.not.match(/^0x/);
      expect(raw.v).to.equal(`0${recoveryParam}`);
      signRawPayload.resolves(raw);

      const signer = new TurnkeyEvmSigner(configFor(wallet.address));
      const signature = await signer._signTypedData(DOMAIN, TYPES, MESSAGE);

      // Canonical joined ECDSA signature: 0x + r(64) + s(64) + v(2).
      expect(signature).to.match(/^0x[0-9a-f]{130}$/);
      const recovered = ethers.utils.verifyTypedData(
        DOMAIN,
        TYPES,
        MESSAGE,
        signature,
      );
      expect(recovered).to.equal(wallet.address);
    });
  }

  it('throws when Turnkey omits signature components', async () => {
    const wallet = ethers.Wallet.createRandom();
    const realSignature = await wallet._signTypedData(DOMAIN, TYPES, MESSAGE);
    const raw = toTurnkeyRawResult(realSignature);
    signRawPayload.resolves({
      activity: raw.activity,
      r: undefined,
      s: raw.s,
      v: raw.v,
    });

    const signer = new TurnkeyEvmSigner(configFor(wallet.address));
    let error: unknown;
    try {
      await signer._signTypedData(DOMAIN, TYPES, MESSAGE);
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).to.equal(
        'Missing signature components from Turnkey',
      );
    }
  });
});

describe('TurnkeyEvmSigner._signTypedData ENS resolution', () => {
  const ENS_TYPES = {
    SafeTx: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
  };
  const ENS_NAME = 'alice.eth';
  const RESOLVED_ADDRESS = '0x000000000000000000000000000000000000dEaD';

  let signRawPayload: sinon.SinonStub;

  beforeEach(() => {
    signRawPayload = sinon.stub();
    const fakeClient = { signRawPayload };
    // CAST: test double — TurnkeyServerClient is a large generated client;
    // the signer only calls signRawPayload, which this stub provides.
    sinon
      .stub(TurnkeyClientManager.prototype, 'getClient')
      .returns(fakeClient as unknown as TurnkeyServerClient);
  });

  afterEach(() => {
    sinon.restore();
  });

  function fakeProvider(
    resolveName: sinon.SinonStub,
  ): ethers.providers.Provider {
    // CAST: test double — ethers.providers.Provider is a large abstract
    // class; the signer only calls resolveName during ENS resolution.
    return { resolveName } as unknown as ethers.providers.Provider;
  }

  it('resolves an ENS name in an address field before encoding', async () => {
    const wallet = ethers.Wallet.createRandom();
    const resolvedValue = { to: RESOLVED_ADDRESS, value: '0' };
    const realSignature = await wallet._signTypedData(
      DOMAIN,
      ENS_TYPES,
      resolvedValue,
    );
    signRawPayload.resolves(toTurnkeyRawResult(realSignature));

    const resolveName = sinon.stub().resolves(RESOLVED_ADDRESS);
    const signer = new TurnkeyEvmSigner(
      configFor(wallet.address),
      fakeProvider(resolveName),
    );

    await signer._signTypedData(DOMAIN, ENS_TYPES, {
      to: ENS_NAME,
      value: '0',
    });

    expect(resolveName.calledOnceWith(ENS_NAME)).to.be.true;
    const payload = JSON.parse(signRawPayload.getCall(0).args[0].payload);
    expect(payload.message.to).to.equal(RESOLVED_ADDRESS.toLowerCase());
    expect(payload.message.to).to.not.equal(ENS_NAME);
  });

  it('rejects an ENS name when no provider is configured', async () => {
    const wallet = ethers.Wallet.createRandom();
    const signer = new TurnkeyEvmSigner(configFor(wallet.address));

    let error: unknown;
    try {
      await signer._signTypedData(DOMAIN, ENS_TYPES, {
        to: ENS_NAME,
        value: '0',
      });
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).to.include('without a provider');
    }
    expect(signRawPayload.called).to.be.false;
  });
});

describe('normalizeSignatureComponent', () => {
  const HEX_64 = 'a'.repeat(64);

  it('returns a bare-hex component 0x-prefixed', () => {
    expect(normalizeSignatureComponent('r', HEX_64)).to.equal(`0x${HEX_64}`);
  });

  it('accepts an already-0x-prefixed component', () => {
    expect(normalizeSignatureComponent('r', `0x${HEX_64}`)).to.equal(
      `0x${HEX_64}`,
    );
  });

  it('normalizes 0x-prefixed and bare forms to the same value', () => {
    expect(normalizeSignatureComponent('s', HEX_64)).to.equal(
      normalizeSignatureComponent('s', `0x${HEX_64}`),
    );
  });

  it('rejects a too-short component', () => {
    expect(() => normalizeSignatureComponent('r', 'a'.repeat(63))).to.throw(
      'Invalid r value from Turnkey',
    );
  });

  it('rejects a too-long component', () => {
    expect(() => normalizeSignatureComponent('s', 'a'.repeat(65))).to.throw(
      'Invalid s value from Turnkey',
    );
  });

  it('rejects a non-hex component and names the label', () => {
    expect(() =>
      normalizeSignatureComponent('r', `g${'a'.repeat(63)}`),
    ).to.throw('Invalid r value from Turnkey');
  });
});

describe('normalizeRecoveryV', () => {
  type Case = { name: string; v: string; expected: number };
  const cases: Case[] = [
    { name: 'lifts recovery id 00 to 27', v: '00', expected: 27 },
    { name: 'lifts recovery id 01 to 28', v: '01', expected: 28 },
    { name: 'passes 1b (27) through', v: '1b', expected: 27 },
    { name: 'passes 1c (28) through', v: '1c', expected: 28 },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(normalizeRecoveryV(c.v)).to.equal(c.expected);
    });
  }

  it('throws on a non-hex v', () => {
    expect(() => normalizeRecoveryV('zz')).to.throw(
      'Invalid v value from Turnkey: zz',
    );
  });

  it('throws on an empty v', () => {
    expect(() => normalizeRecoveryV('')).to.throw(
      'Invalid v value from Turnkey',
    );
  });

  it('throws on a hex-but-unsupported recovery id', () => {
    expect(() => normalizeRecoveryV('05')).to.throw(
      'Unsupported recovery id from Turnkey: 05',
    );
  });
});
