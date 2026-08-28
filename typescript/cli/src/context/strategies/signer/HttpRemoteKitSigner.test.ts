import { createServer, type Server } from 'node:http';

import {
  AccountRole,
  assertIsTransactionWithinSizeLimit,
  appendTransactionMessageInstruction,
  blockhash,
  compressTransactionMessageUsingAddressLookupTables,
  createSignableMessage,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { expect } from 'chai';
import { afterEach, describe, it } from 'mocha';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { HttpRemoteKitSigner } from './HttpRemoteKitSigner.js';
import { HttpSignerClient } from './HttpSignerClient.js';

const TOKEN = 'ab'.repeat(32);
const CHAIN = 'svmlocal';
const transactionDecoder = getTransactionDecoder();

describe('HttpRemoteKitSigner HTTP integration', function () {
  this.timeout(10_000);

  let server: Server | undefined;

  afterEach(async () => {
    const activeServer = server;
    server = undefined;
    if (!activeServer) return;
    activeServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      activeServer.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('signs a v0 wire transaction over HTTP and merges a local signature', async () => {
    const remoteKey = await generateKeyPairSigner();
    const localKey = await generateKeyPairSigner();
    const lookupTable = await generateKeyPairSigner();
    const lookedUpAccount = await generateKeyPairSigner();
    let signingRequests = 0;

    server = createServer(async (request, response) => {
      try {
        expect(request.headers.authorization).to.equal(`Bearer ${TOKEN}`);
        response.setHeader('Content-Type', 'application/json');
        if (request.method === 'GET') {
          response.end(
            JSON.stringify({
              chain: CHAIN,
              protocol: ProtocolType.Sealevel,
              address: remoteKey.address,
              curve: 'ed25519',
            }),
          );
          return;
        }

        signingRequests += 1;
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          chain: string;
          transaction: { encoding: string; value: string };
        };
        expect(body.chain).to.equal(CHAIN);
        expect(body.transaction.encoding).to.equal('base64');
        const unsigned = transactionDecoder.decode(
          Buffer.from(body.transaction.value, 'base64'),
        );
        assertIsTransactionWithinSizeLimit(unsigned);
        const [signatureDictionary] = await remoteKey.signMessages([
          createSignableMessage(Uint8Array.from(unsigned.messageBytes)),
        ]);
        const signed = {
          ...unsigned,
          signatures: { ...unsigned.signatures, ...signatureDictionary },
        };
        assertIsTransactionWithinSizeLimit(signed);
        const signedTransaction = getBase64EncodedWireTransaction(signed);
        response.end(
          JSON.stringify({
            chain: CHAIN,
            signerAddress: remoteKey.address,
            signedTransaction: {
              encoding: 'base64',
              value: signedTransaction,
            },
          }),
        );
      } catch (error) {
        response.statusCode = 500;
        response.end(
          JSON.stringify({
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    );
    const boundAddress = server.address();
    if (!boundAddress || typeof boundAddress === 'string') {
      throw new Error('Test signer did not bind a TCP port');
    }

    const remoteSigner = await HttpRemoteKitSigner.create(
      CHAIN,
      new HttpSignerClient(
        new URL(`http://127.0.0.1:${boundAddress.port}`),
        TOKEN,
      ),
    );
    const base = createTransactionMessage({ version: 0 });
    const withFeePayer = setTransactionMessageFeePayerSigner(
      remoteSigner,
      base,
    );
    const withLifetime = setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash('11111111111111111111111111111111'),
        lastValidBlockHeight: 1n,
      },
      withFeePayer,
    );
    const uncompressedMessage = appendTransactionMessageInstruction(
      {
        programAddress: localKey.address,
        accounts: [
          {
            address: localKey.address,
            role: AccountRole.READONLY_SIGNER,
            signer: localKey,
          },
          {
            address: lookedUpAccount.address,
            role: AccountRole.READONLY,
          },
        ],
      },
      withLifetime,
    );
    const message = compressTransactionMessageUsingAddressLookupTables(
      uncompressedMessage,
      { [lookupTable.address]: [lookedUpAccount.address] },
    );

    const signed = await signTransactionMessageWithSigners(message);

    expect(signingRequests).to.equal(1);
    expect(signed.signatures[remoteKey.address]).to.have.length(64);
    expect(signed.signatures[localKey.address]).to.have.length(64);
  });

  it('rejects a signing response for another chain', async () => {
    const remoteKey = await generateKeyPairSigner();
    const client = new HttpSignerClient(
      new URL('http://127.0.0.1:3333'),
      TOKEN,
    );
    client.getAccount = async () => ({
      chain: CHAIN,
      protocol: ProtocolType.Sealevel,
      address: remoteKey.address,
      curve: 'ed25519',
    });
    client.signEncodedTransaction = async () => ({
      chain: 'anotherchain',
      signerAddress: remoteKey.address,
      signedTransaction: { encoding: 'base64', value: '' },
    });
    const remoteSigner = await HttpRemoteKitSigner.create(CHAIN, client);
    const message = setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash('11111111111111111111111111111111'),
        lastValidBlockHeight: 1n,
      },
      setTransactionMessageFeePayerSigner(
        remoteSigner,
        createTransactionMessage({ version: 0 }),
      ),
    );

    let signingError: Error | undefined;
    try {
      await signTransactionMessageWithSigners(message);
    } catch (error) {
      signingError = error instanceof Error ? error : new Error(String(error));
    }
    expect(signingError?.message).to.include(
      'returned transaction for anotherchain',
    );
  });
});
