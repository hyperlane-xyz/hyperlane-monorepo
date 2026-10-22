import { expect } from 'chai';
import { Wallet, providers, utils } from 'ethers';
import Fastify from 'fastify';
import { pino } from 'pino';
import sinon from 'sinon';

import {
  CommitmentReadIsmService__factory,
  InterchainAccountRouter__factory,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import { InterchainAccount, MultiProvider } from '@hyperlane-xyz/sdk';
import { offchainLookupRequestMessageHash } from '@hyperlane-xyz/sdk/ism/utils';
import {
  commitmentFromIcaCalls,
  encodeIcaCalls,
  normalizeCalls,
} from '@hyperlane-xyz/sdk/middleware/account/icaCalls';
import { addressToBytes32, formatMessage } from '@hyperlane-xyz/utils';

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

async function server(
  authorizedSigners: string[] = [wallet.address],
  dependencies?: { multiProvider: MultiProvider; icaApp: InterchainAccount },
) {
  const app = Fastify({ loggerInstance: pino({ level: 'silent' }) });
  await registerRateLimiting(app);
  const service = new CallCommitmentsService(
    {
      serviceName: 'callCommitments',
      baseUrl: origin + '/callCommitments',
      multiProvider:
        dependencies?.multiProvider ?? sinon.createStubInstance(MultiProvider),
    },
    dependencies?.icaApp ?? sinon.createStubInstance(InterchainAccount),
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

  it('forwards the origin transaction hash only after authenticating a reveal request', async () => {
    const fetch = sinon
      .stub(CallCommitmentsService.prototype, 'handleFetchCommitment')
      .resolves('0x1234');
    const app = await server();
    const originTxHash = '0x' + '34'.repeat(32);
    const signature = await wallet.signMessage(
      utils.arrayify(
        offchainLookupRequestMessageHash(sender, data, origin + postPath),
      ),
    );
    try {
      const unauthenticated = await app.inject({
        method: 'POST',
        url: postPath,
        payload: { sender, data, origin_tx_hash: originTxHash },
      });
      expect(unauthenticated.statusCode).to.equal(401);
      expect(fetch.called).to.be.false;

      const response = await app.inject({
        method: 'POST',
        url: postPath,
        payload: { sender, data, signature, origin_tx_hash: originTxHash },
      });

      expect(response.statusCode).to.equal(200);
      expect(fetch.calledOnce).to.be.true;
      expect(fetch.firstCall.args[3]).to.equal(originTxHash);
    } finally {
      await app.close();
    }
  });

  it('rejects malformed origin transaction hints instead of serving stored routing metadata', async () => {
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
      for (const originTxHash of ['0x1234', '']) {
        const response = await app.inject({
          method: 'POST',
          url: postPath,
          payload: { sender, data, signature, origin_tx_hash: originTxHash },
        });

        expect(response.statusCode).to.equal(400);
        expect(response.json().error).to.equal('Invalid origin_tx_hash');
      }
      expect(fetch.called).to.be.false;
    } finally {
      await app.close();
    }
  });

  it('treats null and non-string origin transaction hints as absent', async () => {
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
      for (const originTxHash of [null, 1234, false, {}]) {
        const response = await app.inject({
          method: 'POST',
          url: postPath,
          payload: { sender, data, signature, origin_tx_hash: originTxHash },
        });
        expect(response.statusCode).to.equal(200);
        expect(fetch.lastCall.args[3]).to.equal(undefined);
      }
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

describe('CCS authenticated reveal recovery integration', () => {
  afterEach(() => sinon.restore());

  async function fixture() {
    const originRouter = '0x' + '31'.repeat(20);
    const destinationRouter = '0x' + '32'.repeat(20);
    const mailbox = '0x' + '33'.repeat(20);
    const originTxHash = '0x' + '34'.repeat(32);
    const oldIca = '0x' + '35'.repeat(20);
    const correctIca = '0x' + '36'.repeat(20);
    const salt = '0x' + '00'.repeat(32);
    const calls = [{ to: sender, value: '0', data: '0x' }];
    const commitment = commitmentFromIcaCalls(normalizeCalls(calls), salt);
    const committedMessage = formatMessage(
      3,
      10,
      8453,
      originRouter,
      42161,
      destinationRouter,
      utils.solidityPack(
        ['uint8', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
        [1, addressToBytes32(wallet.address), salt, salt, commitment],
      ),
    );
    const message = formatMessage(
      3,
      11,
      8453,
      originRouter,
      42161,
      destinationRouter,
      utils.solidityPack(
        ['uint8', 'bytes32', 'bytes32'],
        [2, salt, commitment],
      ),
    );
    const mailboxInterface = Mailbox__factory.createInterface();
    const logs = [committedMessage, message].map((raw, logIndex) => ({
      address: mailbox,
      logIndex,
      ...mailboxInterface.encodeEventLog(
        mailboxInterface.getEvent('Dispatch'),
        [originRouter, 42161, addressToBytes32(destinationRouter), raw],
      ),
    }));
    const originProvider = new providers.JsonRpcProvider();
    const destinationProvider = new providers.JsonRpcProvider();
    const receipt = sinon
      .stub(originProvider, 'getTransactionReceipt')
      .resolves({ logs });
    sinon
      .stub(originProvider, 'call')
      .resolves(utils.defaultAbiCoder.encode(['address'], [mailbox]));
    const destinationCall = sinon
      .stub(destinationProvider, 'call')
      .resolves(utils.defaultAbiCoder.encode(['address'], [correctIca]));
    const multiProvider = sinon.createStubInstance(MultiProvider);
    multiProvider.getChainName.withArgs(8453).returns('base');
    multiProvider.getProvider.withArgs('base').returns(originProvider);
    multiProvider.getProvider.withArgs(42161).returns(destinationProvider);
    const icaApp = sinon.createStubInstance(InterchainAccount);
    icaApp.getContracts.withArgs('base').returns({
      interchainAccountRouter: InterchainAccountRouter__factory.connect(
        originRouter,
        originProvider,
      ),
    });
    const record = {
      commitment,
      calls,
      salt,
      ica: oldIca,
      originDomain: 8453,
      relayers: [wallet.address],
    };
    const findUnique = sinon.stub().resolves(record);
    const updateMany = sinon.stub().resolves({ count: 1 });
    sinon.stub(prisma, 'commitment').value({ findUnique, updateMany });
    const app = await server([wallet.address], { multiProvider, icaApp });
    const data =
      CommitmentReadIsmService__factory.createInterface().encodeFunctionData(
        'getCallsFromRevealMessage',
        [message],
      );
    const signature = await wallet.signMessage(
      utils.arrayify(
        offchainLookupRequestMessageHash(sender, data, origin + postPath),
      ),
    );
    const payload = { sender, data, signature, origin_tx_hash: originTxHash };
    return {
      app,
      payload,
      receipt,
      destinationCall,
      record,
      updateMany,
      correctIca,
      salt,
      calls,
      commitment,
    };
  }

  it('authenticates and derives from the actual router pair without database writes', async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject({
        method: 'POST',
        url: postPath,
        payload: f.payload,
      });
      expect(response.statusCode).to.equal(200);
      expect(response.json().data).to.equal(
        f.correctIca + encodeIcaCalls(normalizeCalls(f.calls), f.salt).slice(2),
      );
      sinon.assert.notCalled(f.updateMany);
      sinon.assert.calledOnce(f.receipt);
      sinon.assert.calledOnce(f.destinationCall);
    } finally {
      await f.app.close();
    }
  });

  it('serves a Rust None/null hint from the stored ICA without RPC reads', async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject({
        method: 'POST',
        url: postPath,
        payload: { ...f.payload, origin_tx_hash: null },
      });
      expect(response.statusCode).to.equal(200);
      expect(response.json().data).to.equal(
        f.record.ica + encodeIcaCalls(normalizeCalls(f.calls), f.salt).slice(2),
      );
      sinon.assert.notCalled(f.receipt);
      sinon.assert.notCalled(f.updateMany);
    } finally {
      await f.app.close();
    }
  });

  for (const failure of ['missing receipt', 'origin RPC failure'] as const) {
    it(`returns HTTP 500 for ${failure}, without a successful metadata response`, async () => {
      const f = await fixture();
      if (failure === 'missing receipt') f.receipt.resolves(null);
      else f.receipt.rejects(new Error('origin RPC unavailable'));
      try {
        const response = await f.app.inject({
          method: 'POST',
          url: postPath,
          payload: f.payload,
        });
        expect(response.statusCode).to.equal(500);
        expect(response.json()).to.have.property('error');
        expect(response.json()).not.to.have.property('data');
        sinon.assert.notCalled(f.destinationCall);
        sinon.assert.notCalled(f.updateMany);
      } finally {
        await f.app.close();
      }
    });
  }
});
