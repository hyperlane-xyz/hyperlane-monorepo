import { expect } from 'chai';
import { Wallet, utils } from 'ethers';
import Fastify from 'fastify';
import { pino } from 'pino';
import sinon from 'sinon';

import { CommitmentReadIsmService__factory } from '@hyperlane-xyz/core';
import { InterchainAccount, MultiProvider } from '@hyperlane-xyz/sdk';
import { offchainLookupRequestMessageHash } from '@hyperlane-xyz/sdk/ism/utils';

import { prisma } from '../../src/db.js';
import { CallCommitmentsService } from '../../src/services/CallCommitmentsService.js';
import { registerRateLimiting } from '../../src/utils/rateLimit.js';

const origin = 'https://ccs.example';
const path = '/callCommitments/calldata/0x' + '11'.repeat(32);
const wallet = new Wallet('0x' + '01'.repeat(32));
const other = new Wallet('0x' + '02'.repeat(32));
const sender = '0x' + '03'.repeat(20);
const postPath = '/callCommitments/getCallsFromRevealMessage';
const data =
  CommitmentReadIsmService__factory.createInterface().encodeFunctionData(
    'getCallsFromRevealMessage',
    ['0x1234'],
  );

async function headers(
  signer = wallet,
  commitment = '0x' + '11'.repeat(32),
  baseUrl = origin,
  claimedSender = signer.address,
) {
  const signature = await signer.signMessage(
    utils.arrayify(
      offchainLookupRequestMessageHash(
        claimedSender,
        commitment,
        baseUrl + '/callCommitments/calldata',
      ),
    ),
  );
  return {
    authorization: `Hyperlane-Signature ${signature}`,
    'x-hyperlane-sender': claimedSender,
  };
}

async function server(authorizedSigners: string[] = [wallet.address]) {
  const app = Fastify({ loggerInstance: pino({ level: 'silent' }) });
  await registerRateLimiting(app);
  const service = new CallCommitmentsService(
    {
      serviceName: 'callCommitments',
      baseUrl: origin + '/callCommitments',
      multiProvider: sinon.createStubInstance(MultiProvider),
    },
    sinon.createStubInstance(InterchainAccount),
    authorizedSigners,
  );
  service.registerRoutes(app, '/callCommitments');
  return app;
}

describe('CCS read authentication', () => {
  afterEach(() => sinon.restore());

  it('requires an allowed signer before reading calldata, even with an empty record allowlist', async () => {
    const db = sinon.stub().resolves({
      originDomain: 1,
      data: '0x1234',
      salt: '0x00',
      relayers: [],
      destinationAccount: '0x1234',
      revealAccounts: null,
      createdAt: new Date(),
      commitment: '0x' + '11'.repeat(32),
    });
    sinon.stub(prisma, 'calldata').value({ findUnique: db });
    const app = await server();
    try {
      expect(
        (await app.inject({ method: 'GET', url: path })).statusCode,
      ).to.equal(401);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: path,
            headers: await headers(other),
          })
        ).statusCode,
      ).to.equal(403);
      expect(db.called).to.equal(false);
      const response = await app.inject({
        method: 'GET',
        url: path,
        headers: await headers(),
      });
      expect(response.statusCode).to.equal(200);
      expect(response.json().data).to.equal('0x1234');
      expect(response.headers['cache-control']).to.equal('no-store');
      const lowerCaseHeaders = await headers();
      expect(
        (
          await app.inject({
            method: 'GET',
            url: path,
            headers: {
              ...lowerCaseHeaders,
              authorization: lowerCaseHeaders.authorization.replace(
                'Hyperlane-Signature',
                'hyperlane-signature',
              ),
            },
          })
        ).statusCode,
      ).to.equal(200);
    } finally {
      await app.close();
    }
  });

  it('enforces per-commitment restrictions on top of the global whitelist', async () => {
    const db = sinon.stub().resolves({
      originDomain: 1,
      data: '0x1234',
      salt: '0x00',
      relayers: [other.address],
      destinationAccount: '0x1234',
      revealAccounts: null,
      createdAt: new Date(),
      commitment: '0x' + '11'.repeat(32),
    });
    sinon.stub(prisma, 'calldata').value({ findUnique: db });
    const app = await server();
    try {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: path,
            headers: await headers(),
          })
        ).statusCode,
      ).to.equal(403);
    } finally {
      await app.close();
    }
  });

  it('rejects tampered, cross-service, non-EVM, and query-string-only credentials', async () => {
    const db = sinon.stub();
    sinon.stub(prisma, 'calldata').value({ findUnique: db });
    const app = await server();
    try {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: path,
            headers: await headers(wallet, undefined, origin, other.address),
          })
        ).statusCode,
      ).to.equal(401);
      for (const requestHeaders of [
        await headers(wallet, '0x' + '22'.repeat(32)),
        await headers(wallet, undefined, 'https://other.example'),
        { ...(await headers()), 'x-hyperlane-sender': other.address },
        {
          ...(await headers()),
          authorization: 'Hyperlane-Signature 0xgarbage',
        },
        { ...(await headers()), authorization: 'Hyperlane-Ed25519 invalid' },
        {
          ...(await headers()),
          'x-hyperlane-sender': 'G5FM3UKwcBJ47PwLWLLY1RQpqNtTMgnqnd6nZGcJqaBp',
        },
      ]) {
        const response = await app.inject({
          method: 'GET',
          url: path,
          headers: requestHeaders,
        });
        expect([401, 403]).to.include(response.statusCode);
      }
      expect(
        (
          await app.inject({
            method: 'GET',
            url: path + '?sender=' + wallet.address + '&signature=0x1234',
          })
        ).statusCode,
      ).to.equal(401);
      expect(db.called).to.equal(false);
    } finally {
      await app.close();
    }
  });

  it('accepts the existing POST body signature and restricts it to the global whitelist', async () => {
    const fetch = sinon
      .stub(CallCommitmentsService.prototype, 'handleFetchCommitment')
      .resolves('0x1234');
    const app = await server();
    const signature = await wallet.signMessage(
      utils.arrayify(
        offchainLookupRequestMessageHash(sender, data, origin + postPath),
      ),
    );
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: postPath,
            payload: { sender, data },
          })
        ).statusCode,
      ).to.equal(401);
      const response = await app.inject({
        method: 'POST',
        url: postPath,
        payload: { sender, data, signature },
      });
      expect(response.statusCode).to.equal(200);
      expect(fetch.lastCall.args[1]).to.equal(wallet.address.toLowerCase());
      for (const payload of [
        { sender: other.address, data, signature },
        { sender, data: data + '00', signature },
        {
          sender,
          data,
          signature: await other.signMessage(
            utils.arrayify(
              offchainLookupRequestMessageHash(sender, data, origin + postPath),
            ),
          ),
        },
      ]) {
        expect(
          (await app.inject({ method: 'POST', url: postPath, payload }))
            .statusCode,
        ).to.equal(403);
      }
      expect(fetch.callCount).to.equal(1);
    } finally {
      await app.close();
    }
  });

  it('denies all reads with an empty whitelist', async () => {
    const app = await server([]);
    try {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: path,
            headers: await headers(),
          })
        ).statusCode,
      ).to.equal(403);
    } finally {
      await app.close();
    }
  });
});
