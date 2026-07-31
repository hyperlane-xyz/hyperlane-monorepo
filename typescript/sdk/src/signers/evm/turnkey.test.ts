import { expect } from 'chai';
import { ethers } from 'ethers';
import sinon from 'sinon';

import type { TurnkeyServerClient } from '@turnkey/sdk-server';

import { TurnkeyClientManager, TurnkeyConfig } from '../turnkeyClient.js';

import { TurnkeyEvmSigner } from './turnkey.js';

const CONFIG: TurnkeyConfig = {
  organizationId: 'org-id',
  apiPublicKey: 'api-public-key',
  apiPrivateKey: 'api-private-key',
  privateKeyId: 'private-key-id',
  publicKey: '0xa7EC0000000000000000000000000000000000d9',
};

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

describe('TurnkeyEvmSigner._signTypedData', () => {
  let signRawPayload: sinon.SinonStub;

  beforeEach(() => {
    signRawPayload = sinon.stub();
    const fakeClient = { signRawPayload };
    sinon
      .stub(TurnkeyClientManager.prototype, 'getClient')
      .returns(fakeClient as unknown as TurnkeyServerClient);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('submits the EIP-712 payload so policy can inspect the message', async () => {
    signRawPayload.resolves({
      activity: { status: 'ACTIVITY_STATUS_COMPLETED' },
      r: `0x${'11'.repeat(32)}`,
      s: `0x${'22'.repeat(32)}`,
      v: '1b',
    });

    const signer = new TurnkeyEvmSigner(CONFIG);
    const signature = await signer._signTypedData(DOMAIN, TYPES, MESSAGE);

    expect(signRawPayload.calledOnce).to.be.true;
    const arg = signRawPayload.getCall(0).args[0];
    expect(arg.encoding).to.equal('PAYLOAD_ENCODING_EIP712');
    expect(arg.signWith).to.equal(CONFIG.publicKey);

    // ethers' getPayload canonicalizes the EIP-712 message: addresses are
    // lowercased and numeric fields are stringified.
    const payload = JSON.parse(arg.payload);
    expect(payload.primaryType).to.equal('SafeTx');
    expect(payload.types.EIP712Domain).to.be.an('array');
    expect(payload.message.to).to.equal(MESSAGE.to.toLowerCase());
    expect(payload.message.operation).to.equal(String(MESSAGE.operation));
    expect(payload.message.nonce).to.equal(String(MESSAGE.nonce));

    // Canonical joined ECDSA signature: 0x + r(64) + s(64) + v(2).
    expect(signature).to.match(/^0x[0-9a-f]{130}$/);
  });

  it('throws when Turnkey omits signature components', async () => {
    signRawPayload.resolves({
      activity: { status: 'ACTIVITY_STATUS_COMPLETED' },
      r: undefined,
      s: `0x${'22'.repeat(32)}`,
      v: '1b',
    });

    const signer = new TurnkeyEvmSigner(CONFIG);
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
