import { generateKeyPairSync } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import { expect } from 'chai';
import { ethers } from 'ethers';
import { describe, it } from 'mocha';
import { z } from 'zod';
import {
  blockhash,
  compileTransaction,
  createSignableMessage,
  createTransactionMessage,
  generateKeyPairSigner,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  getTransactionEncoder,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  verifySignature,
} from '@solana/kit';

import { type TurnkeyConfig } from '@hyperlane-xyz/sdk';
import {
  Eip712PayloadSchema,
  SignerBackendError,
} from '@hyperlane-xyz/http-registry-server';
import {
  ProtocolType,
  assert,
  ensure0x,
  fromHexString,
  strip0x,
} from '@hyperlane-xyz/utils';

import { TurnkeyTransactionSignerBackend } from '../src/utils/turnkey.js';

const JsonRecordSchema = z.record(z.unknown());

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JsonRecordSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
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
  it('uses the Turnkey HTTP contract for EVM, SVM, and EIP-712', async function () {
    this.timeout(20_000);
    const wallet = ethers.Wallet.createRandom();
    const solanaSigner = await generateKeyPairSigner();
    let signRequest: Record<string, unknown> | undefined;
    let rawPayloadRequest: Record<string, unknown> | undefined;
    let signActivityStatus = 'ACTIVITY_STATUS_COMPLETED';
    const turnkeyApi = createServer(async (request, response) => {
      if (request.url === '/public/v1/query/whoami') {
        sendJson(response, { organizationId: 'organization-id' });
        return;
      }
      if (request.url === '/public/v1/query/get_private_key') {
        const body = await readJson(request);
        const isSolana = body.privateKeyId === 'solana-private-key-id';
        sendJson(response, {
          privateKey: {
            privateKeyId: isSolana ? 'solana-private-key-id' : 'private-key-id',
            curve: isSolana ? 'CURVE_ED25519' : 'CURVE_SECP256K1',
            addresses: [
              {
                format: isSolana
                  ? 'ADDRESS_FORMAT_SOLANA'
                  : 'ADDRESS_FORMAT_ETHEREUM',
                address: isSolana ? solanaSigner.address : wallet.address,
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
        if (signRequest.type === 'TRANSACTION_TYPE_SOLANA') {
          const transaction = getTransactionDecoder().decode(
            Buffer.from(signRequest.unsignedTransaction, 'hex'),
          );
          const [signature] = await solanaSigner.signMessages([
            createSignableMessage(Uint8Array.from(transaction.messageBytes)),
          ]);
          const signedTransaction = getTransactionEncoder().encode({
            ...transaction,
            signatures: { ...transaction.signatures, ...signature },
          });
          sendJson(response, {
            activity: {
              id: 'solana-activity-id',
              status: 'ACTIVITY_STATUS_COMPLETED',
              result: {
                signTransactionResult: {
                  signedTransaction:
                    Buffer.from(signedTransaction).toString('hex'),
                },
              },
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
      if (request.url === '/public/v1/submit/sign_raw_payload') {
        const body = await readJson(request);
        const parameters = body.parameters;
        assert(isRecord(parameters), 'Expected Turnkey parameters');
        rawPayloadRequest = parameters;
        assert(
          typeof parameters.payload === 'string',
          'Expected EIP-712 payload',
        );
        const typedData = Eip712PayloadSchema.parse(
          JSON.parse(parameters.payload),
        );
        const { EIP712Domain: _domain, ...types } = typedData.types;
        const signature = ethers.utils.splitSignature(
          await wallet._signTypedData(
            typedData.domain,
            types,
            typedData.message,
          ),
        );
        sendJson(response, {
          activity: {
            id: 'typed-data-activity-id',
            status: 'ACTIVITY_STATUS_COMPLETED',
            result: {
              signRawPayloadResult: {
                r: strip0x(signature.r),
                s: strip0x(signature.s),
                v: signature.v.toString(16),
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

      const typedData = Eip712PayloadSchema.parse({
        types: {
          EIP712Domain: [{ name: 'chainId', type: 'uint256' }],
          Mail: [{ name: 'contents', type: 'string' }],
        },
        primaryType: 'Mail',
        domain: { chainId: '31337' },
        message: { contents: 'hello' },
      });
      const typedDataResult = await backend.signTypedData(typedData);
      expect(rawPayloadRequest).to.deep.include({
        signWith: config.privateKeyId,
        payload: JSON.stringify(typedData),
        encoding: 'PAYLOAD_ENCODING_EIP712',
        hashFunction: 'HASH_FUNCTION_NO_OP',
      });
      expect(typedDataResult.backendRequestId).to.equal(
        'typed-data-activity-id',
      );
      const { EIP712Domain: _domain, ...types } = typedData.types;
      expect(
        ethers.utils.verifyTypedData(
          typedData.domain,
          types,
          typedData.message,
          typedDataResult.signature,
        ),
      ).to.equal(wallet.address);

      const solanaConfig: TurnkeyConfig = {
        ...config,
        privateKeyId: 'solana-private-key-id',
        publicKey: solanaSigner.address,
      };
      const solanaBackend = new TurnkeyTransactionSignerBackend(
        solanaConfig,
        ProtocolType.Sealevel,
      );
      await solanaBackend.healthCheck();
      const solanaMessage = setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash('11111111111111111111111111111111'),
          lastValidBlockHeight: 1n,
        },
        setTransactionMessageFeePayerSigner(
          solanaSigner,
          createTransactionMessage({ version: 0 }),
        ),
      );
      const unsignedSolanaTransaction = getTransactionEncoder().encode(
        compileTransaction(solanaMessage),
      );
      const solanaResult = await solanaBackend.signTransaction(
        ProtocolType.Sealevel,
        Uint8Array.from(unsignedSolanaTransaction),
      );
      expect(signRequest).to.include({
        signWith: solanaConfig.privateKeyId,
        type: 'TRANSACTION_TYPE_SOLANA',
        unsignedTransaction: Buffer.from(unsignedSolanaTransaction).toString(
          'hex',
        ),
      });
      expect(solanaResult.backendRequestId).to.equal('solana-activity-id');
      const signedSolanaTransaction = getTransactionDecoder().decode(
        solanaResult.signedTransaction,
      );
      const decodedUnsignedSolanaTransaction = getTransactionDecoder().decode(
        unsignedSolanaTransaction,
      );
      expect(
        Buffer.from(
          Uint8Array.from(signedSolanaTransaction.messageBytes),
        ).equals(
          Uint8Array.from(decodedUnsignedSolanaTransaction.messageBytes),
        ),
      ).to.equal(true);
      const solanaSignature =
        signedSolanaTransaction.signatures[solanaSigner.address];
      assert(solanaSignature, 'Expected Turnkey Solana signature');
      expect(
        await verifySignature(
          await getPublicKeyFromAddress(solanaSigner.address),
          solanaSignature,
          signedSolanaTransaction.messageBytes,
        ),
      ).to.equal(true);

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
