import { generateKeyPairSync } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import { expect } from 'chai';
import { ethers } from 'ethers';
import { describe, it } from 'mocha';

import { type TurnkeyConfig } from '@hyperlane-xyz/sdk';
import { SignerBackendError } from '@hyperlane-xyz/http-registry-server';
import {
  ProtocolType,
  assert,
  ensure0x,
  fromHexString,
  strip0x,
} from '@hyperlane-xyz/utils';

import { TurnkeyTransactionSignerBackend } from '../src/utils/turnkey.js';

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString()) as Record<
    string,
    unknown
  >;
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function apiCredentials() {
  const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = keyPair.privateKey.export({ format: 'jwk' });
  assert(jwk.x && jwk.y && jwk.d, 'Expected complete P-256 JWK');
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  return {
    apiPublicKey: `${y[y.length - 1] & 1 ? '03' : '02'}${x.toString('hex')}`,
    apiPrivateKey: Buffer.from(jwk.d, 'base64url').toString('hex'),
  };
}

describe('TurnkeyTransactionSignerBackend integration', () => {
  it('uses the Turnkey HTTP contract and signs with privateKeyId', async function () {
    this.timeout(20_000);
    const wallet = ethers.Wallet.createRandom();
    let signRequest: Record<string, unknown> | undefined;
    let signActivityStatus = 'ACTIVITY_STATUS_COMPLETED';
    const turnkeyApi = createServer(async (request, response) => {
      if (request.url === '/public/v1/query/whoami') {
        sendJson(response, { organizationId: 'organization-id' });
        return;
      }
      if (request.url === '/public/v1/query/get_private_key') {
        sendJson(response, {
          privateKey: {
            privateKeyId: 'private-key-id',
            curve: 'CURVE_SECP256K1',
            addresses: [
              {
                format: 'ADDRESS_FORMAT_ETHEREUM',
                address: wallet.address,
              },
            ],
          },
        });
        return;
      }
      if (request.url === '/public/v1/query/get_activity') {
        sendJson(response, {
          activity: {
            id: 'activity-id',
            status: signActivityStatus,
            result: {},
          },
        });
        return;
      }
      if (request.url === '/public/v1/submit/sign_transaction') {
        const body = await readJson(request);
        const parameters = body.parameters;
        assert(isRecord(parameters), 'Expected Turnkey parameters');
        signRequest = parameters;
        assert(
          typeof signRequest.unsignedTransaction === 'string',
          'Expected unsigned transaction',
        );
        if (signActivityStatus !== 'ACTIVITY_STATUS_COMPLETED') {
          sendJson(response, {
            activity: {
              id: 'activity-id',
              status: signActivityStatus,
              result: {},
            },
          });
          return;
        }
        const parsed = ethers.utils.parseTransaction(
          ensure0x(signRequest.unsignedTransaction),
        );
        const signedTransaction = await wallet.signTransaction({
          type: parsed.type ?? 0,
          chainId: parsed.chainId,
          nonce: parsed.nonce,
          maxPriorityFeePerGas: parsed.maxPriorityFeePerGas ?? undefined,
          maxFeePerGas: parsed.maxFeePerGas ?? undefined,
          gasLimit: parsed.gasLimit,
          to: parsed.to,
          value: parsed.value,
          data: parsed.data,
          accessList: parsed.accessList,
        });
        sendJson(response, {
          activity: {
            id: 'activity-id',
            status: 'ACTIVITY_STATUS_COMPLETED',
            result: {
              signTransactionResult: {
                signedTransaction: strip0x(signedTransaction),
              },
            },
          },
        });
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      turnkeyApi.once('error', reject);
      turnkeyApi.listen(0, '127.0.0.1', resolve);
    });
    const boundAddress = turnkeyApi.address();
    assert(
      typeof boundAddress === 'object' && boundAddress !== null,
      'Expected mock Turnkey TCP address',
    );
    const config: TurnkeyConfig = {
      organizationId: 'organization-id',
      ...apiCredentials(),
      privateKeyId: 'private-key-id',
      publicKey: wallet.address,
      apiBaseUrl: `http://127.0.0.1:${boundAddress.port}`,
    };

    try {
      const backend = new TurnkeyTransactionSignerBackend(
        config,
        ProtocolType.Ethereum,
      );
      await backend.healthCheck();
      const unsigned = ethers.utils.serializeTransaction({
        type: 2,
        chainId: 31337,
        nonce: 0,
        maxPriorityFeePerGas: 1,
        maxFeePerGas: 2,
        gasLimit: 21_000,
        to: ethers.constants.AddressZero,
        value: 3,
        accessList: [],
      });
      const result = await backend.signTransaction(
        ProtocolType.Ethereum,
        fromHexString(unsigned),
      );

      expect(signRequest).to.include({
        signWith: config.privateKeyId,
        type: 'TRANSACTION_TYPE_ETHEREUM',
      });
      expect(result.backendRequestId).to.equal('activity-id');
      expect(
        ethers.utils.parseTransaction(result.signedTransaction).from,
      ).to.equal(wallet.address);

      for (const [status, kind] of [
        ['ACTIVITY_STATUS_CONSENSUS_NEEDED', 'approvalRequired'],
        ['ACTIVITY_STATUS_REJECTED', 'denied'],
        ['ACTIVITY_STATUS_FAILED', 'unavailable'],
      ] as const) {
        signActivityStatus = status;
        try {
          await backend.signTransaction(
            ProtocolType.Ethereum,
            fromHexString(unsigned),
          );
          expect.fail(`Expected ${status} to throw`);
        } catch (error) {
          if (!(error instanceof SignerBackendError)) throw error;
          expect(error.kind).to.equal(kind);
          expect(error.backendRequestId).to.equal('activity-id');
        }
      }
    } finally {
      turnkeyApi.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        turnkeyApi.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
