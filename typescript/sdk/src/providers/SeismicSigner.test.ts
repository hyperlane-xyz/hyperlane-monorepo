import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { BigNumber, Wallet, providers, utils } from 'ethers';
import {
  AesGcmCrypto,
  AesKeyDomain,
  RESPONSE_FORMAT_VERSION,
  encodeSeismicMetadataAsAAD,
  encodeSeismicResponseAAD,
  generateAesKey,
  randomEncryptionNonce,
} from 'seismic-viem';
import sinon from 'sinon';
import { isHex } from 'viem';
import { z } from 'zod';

import { assert } from '@hyperlane-xyz/utils';

import { SeismicSigner } from './SeismicSigner.js';
import { HyperlaneSmartProvider } from './SmartProvider/SmartProvider.js';

const CHAIN_ID = 5124;
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const SERVER_KEY = `0x${'01'.repeat(32)}`;
const BLOCK_GAS_LIMIT = 45_000_000;
const RECIPIENT = '0x0000000000000000000000000000000000000012';
const DATA = '0x12345678';

chai.use(chaiAsPromised);

describe('SeismicSigner', () => {
  let wallet: Wallet;
  let provider: providers.StaticJsonRpcProvider;
  let send: sinon.SinonStub;
  let rpcBlockNumber: number;
  let rpcNonce: number;
  let revertData: string | undefined;
  let callError: Error | undefined;
  let signer: SeismicSigner;
  let requests: { method: string; params?: unknown[] }[];
  let rpcChainId: number;
  let estimateError: string | undefined;
  // Plaintext return data the stubbed node encrypts into its eth_call reply.
  let callResult: string;

  /**
   * Encrypts `plaintext` the way the TEE encrypts a signed-read response:
   * `version || iv || AES-GCM(body)` under the response key derived from the
   * request's ephemeral encryption pubkey and the server key, with the
   * request metadata (+ version) as AAD.
   */
  async function encryptResponse(
    typedDataMessage: Record<string, unknown>,
    plaintext: string,
  ): Promise<string> {
    const message = z
      .object({
        encryptionPubkey: z.string().refine(isHex),
        encryptionNonce: z.string().refine(isHex),
        nonce: z.coerce.bigint(),
        to: z.string().refine(isHex),
        value: z.coerce.bigint(),
        expiresAtBlock: z.coerce.bigint(),
      })
      .parse(typedDataMessage);
    assert(isHex(SERVER_KEY) && isHex(BLOCK_HASH), 'Expected test hex');
    assert(isHex(wallet.address), 'Expected hex wallet address');
    const responseKey = generateAesKey(
      {
        privateKey: SERVER_KEY,
        networkPublicKey: message.encryptionPubkey.slice(2),
      },
      AesKeyDomain.TxResponse,
    );
    const aad = encodeSeismicResponseAAD(
      {
        sender: wallet.address,
        legacyFields: {
          chainId: CHAIN_ID,
          nonce: Number(message.nonce),
          to: message.to,
          value: message.value,
        },
        seismicElements: {
          encryptionPubkey: message.encryptionPubkey,
          encryptionNonce: message.encryptionNonce,
          messageVersion: 2,
          recentBlockHash: BLOCK_HASH,
          expiresAtBlock: message.expiresAtBlock,
          signedRead: true,
        },
      },
      RESPONSE_FORMAT_VERSION,
    );
    const iv = randomEncryptionNonce();
    assert(isHex(iv) && isHex(plaintext), 'Expected hex');
    const body = await new AesGcmCrypto(responseKey).encrypt(
      plaintext,
      iv,
      aad,
    );
    return `0x${RESPONSE_FORMAT_VERSION.toString(16).padStart(2, '0')}${iv.slice(2)}${body.slice(2)}`;
  }

  beforeEach(() => {
    provider = new providers.StaticJsonRpcProvider(
      'https://configured.example',
      { chainId: CHAIN_ID, name: 'seismic' },
    );
    wallet = Wallet.createRandom().connect(provider);
    signer = new SeismicSigner(wallet, {
      chainId: CHAIN_ID,
      rpcUrl: 'https://seismic.example',
      name: 'seismic',
    });
    requests = [];
    rpcChainId = CHAIN_ID;
    estimateError = undefined;
    rpcBlockNumber = 100;
    rpcNonce = 7;
    revertData = undefined;
    callError = undefined;
    callResult = utils.defaultAbiCoder.encode(['uint256'], [1_000_000]);
    sinon
      .stub(globalThis, 'fetch')
      .rejects(new Error('Unexpected direct HTTP request'));
    send = sinon
      .stub(provider, 'send')
      .callsFake(async (method: string, params: unknown[]) => {
        const request = { method, params };
        requests.push(request);
        const results: Record<string, unknown> = {
          seismic_getTeePublicKey: utils.computePublicKey(SERVER_KEY, true),
          eth_chainId: utils.hexValue(rpcChainId),
          eth_getTransactionCount: utils.hexValue(rpcNonce),
          eth_getBlockByNumber: {
            hash: BLOCK_HASH,
            number: utils.hexValue(rpcBlockNumber),
            gasLimit: utils.hexValue(BLOCK_GAS_LIMIT),
            transactions: [],
          },
          eth_estimateGas: '0x12345',
        };
        if (
          request.method === 'eth_call' ||
          (request.method === 'eth_estimateGas' && revertData)
        ) {
          const signed = z
            .object({
              data: z.object({ message: z.record(z.string(), z.unknown()) }),
              signature: z.object({ r: z.string(), s: z.string() }),
            })
            .parse(request.params?.[0]);
          if (callError) throw callError;
          const encrypted = await encryptResponse(
            signed.data.message,
            revertData ?? callResult,
          );
          if (revertData !== undefined) {
            throw Object.assign(new Error('execution reverted'), {
              code: 3,
              data: encrypted,
            });
          }
          results.eth_call = encrypted;
        }
        assert(request.method in results, `Unexpected RPC ${request.method}`);
        if (request.method === 'eth_estimateGas' && estimateError) {
          throw Object.assign(new Error(estimateError), { code: -32602 });
        }
        return results[request.method];
      });
  });

  afterEach(() => sinon.restore());

  for (const to of [RECIPIENT, undefined]) {
    it(`estimates an authenticated encrypted ${to ? 'call' : 'creation'} with fresh replay protection`, async () => {
      const sign = sinon.spy(wallet, '_signTypedData');
      const gas = await signer.estimateGas({
        to: Promise.resolve(to),
        data: Promise.resolve(DATA),
        value: BigNumber.from(13),
      });
      expect(gas.toHexString()).to.equal('0x012345');
      expect(sign.calledOnce).to.equal(true);
      const [domain, types, message] = sign.firstCall.args;
      expect(message).to.include({
        chainId: CHAIN_ID,
        nonce: 7n,
        gasPrice: 0n,
        gasLimit: BigInt(BLOCK_GAS_LIMIT),
        to: to ?? '0x0000000000000000000000000000000000000000',
        isCreate: to === undefined,
        value: 13n,
        messageVersion: 2,
        recentBlockHash: BLOCK_HASH,
        expiresAtBlock: 200n,
        signedRead: true,
      });
      expect(types).not.to.have.property('EIP712Domain');
      expect(
        utils.verifyTypedData(
          domain,
          types,
          message,
          await sign.firstCall.returnValue,
        ),
      ).to.equal(wallet.address);

      const encrypted = z
        .object({
          encryptionPubkey: z.string().refine(isHex),
          encryptionNonce: z.string().refine(isHex),
          input: z.string().refine(isHex),
        })
        .parse(message);
      assert(
        isHex(SERVER_KEY) && isHex(BLOCK_HASH) && isHex(wallet.address),
        'Expected test hex',
      );
      assert(to === undefined || isHex(to), 'Expected test recipient');
      assert(
        isHex(encrypted.encryptionPubkey) &&
          isHex(encrypted.encryptionNonce) &&
          isHex(encrypted.input),
        'Expected encrypted hex',
      );
      const aesKey = generateAesKey(
        {
          privateKey: SERVER_KEY,
          networkPublicKey: encrypted.encryptionPubkey.slice(2),
        },
        AesKeyDomain.TxRequest,
      );
      const aad = encodeSeismicMetadataAsAAD({
        sender: wallet.address,
        legacyFields: { chainId: CHAIN_ID, nonce: 7, to, value: 13n },
        seismicElements: {
          encryptionPubkey: encrypted.encryptionPubkey,
          encryptionNonce: encrypted.encryptionNonce,
          messageVersion: 2,
          recentBlockHash: BLOCK_HASH,
          expiresAtBlock: 200n,
          signedRead: true,
        },
      });
      expect(
        await new AesGcmCrypto(aesKey).decrypt(
          encrypted.input,
          encrypted.encryptionNonce,
          aad,
        ),
      ).to.equal(DATA);
      const estimate = requests.find(
        ({ method }) => method === 'eth_estimateGas',
      );
      expect(estimate?.params).to.have.length(1);
      expect(estimate?.params?.[0]).to.have.keys('data', 'signature');
      expect(
        requests.find(({ method }) => method === 'eth_getTransactionCount')
          ?.params,
      ).to.deep.equal([wallet.address, 'pending']);
      expect(
        requests.some(({ method }) => method === 'eth_sendRawTransaction'),
      ).to.equal(false);
    });
  }

  it('preserves an explicit nonce and generates fresh encryption for each estimate', async () => {
    const sign = sinon.spy(wallet, '_signTypedData');
    await signer.estimateGas({ to: RECIPIENT, data: DATA, nonce: 0 });
    await signer.estimateGas({ to: RECIPIENT, data: DATA, nonce: 0 });
    expect(sign.firstCall.args[2].nonce).to.equal(0n);
    expect(sign.secondCall.args[2].encryptionNonce).not.to.equal(
      sign.firstCall.args[2].encryptionNonce,
    );
    expect(
      requests.some(({ method }) => method === 'eth_getTransactionCount'),
    ).to.equal(false);
  });

  for (const error of [
    'signed read missing seismic_elements',
    'execution reverted: Ownable: caller is not the owner',
  ]) {
    it(`propagates ${error}`, async () => {
      estimateError = error;
      await expect(
        signer.estimateGas({ to: RECIPIENT, data: DATA }),
      ).to.be.rejectedWith(error);
    });
  }

  it('rejects a mismatched RPC chain before signing', async () => {
    rpcChainId = CHAIN_ID + 1;
    const sign = sinon.spy(wallet, '_signTypedData');
    await expect(signer.estimateGas({ to: RECIPIENT })).to.be.rejectedWith(
      'Seismic RPC chainId mismatch',
    );
    expect(sign.called).to.equal(false);
  });

  it('rejects mismatched transaction sender and chain before requesting RPC', async () => {
    await expect(signer.estimateGas({ from: RECIPIENT })).to.be.rejectedWith(
      'from does not match',
    );
    await expect(
      signer.estimateGas({ chainId: CHAIN_ID + 1 }),
    ).to.be.rejectedWith('chainId does not match');
    expect(requests).to.have.length(0);
  });

  it('fails clearly for signers without typed-data support', async () => {
    Object.defineProperty(wallet, '_signTypedData', { value: undefined });
    await expect(signer.estimateGas({ to: RECIPIENT })).to.be.rejectedWith(
      'requires EIP-712',
    );
    expect(requests).to.have.length(0);
  });

  it('performs a signed read via signedCall and decrypts the response', async () => {
    const sign = sinon.spy(wallet, '_signTypedData');
    const result = await signer.signedCall({ to: RECIPIENT, data: DATA });
    expect(result).to.equal(callResult);
    expect(sign.calledOnce).to.equal(true);
    const [, , message] = sign.firstCall.args;
    expect(message).to.include({ signedRead: true, gasPrice: 0n });
    const call = requests.find(({ method }) => method === 'eth_call');
    expect(call?.params).to.have.length(2);
    expect(call?.params?.[0]).to.have.keys('data', 'signature');
    expect(call?.params?.[1]).to.equal('latest');
    expect(
      requests.some(({ method }) => method === 'eth_estimateGas'),
    ).to.equal(false);
  });

  it('fills a missing gasLimit with the signed estimate before sending', async () => {
    const send = sinon
      .stub(wallet, 'sendTransaction')
      // CAST: the response is never read; only the request passed to the inner signer is asserted.
      .resolves({} as Awaited<ReturnType<Wallet['sendTransaction']>>);
    const estimate = sinon.spy(signer, 'estimateGas');
    await signer.sendTransaction({ to: RECIPIENT, data: DATA });
    expect(estimate.calledOnce).to.equal(true);
    expect(send.calledOnce).to.equal(true);
    const [sent] = send.firstCall.args;
    // 0x12345 + 10% buffer; the inner signer must not estimate again (unsigned).
    expect(BigNumber.from(sent.gasLimit).toNumber()).to.equal(
      Math.floor((0x12345 * 110) / 100),
    );
    expect(sent).to.include({ to: RECIPIENT, data: DATA });
  });

  it('sends an explicit gasLimit through without estimating', async () => {
    const send = sinon
      .stub(wallet, 'sendTransaction')
      // CAST: the response is never read; only the request passed to the inner signer is asserted.
      .resolves({} as Awaited<ReturnType<Wallet['sendTransaction']>>);
    const estimate = sinon.spy(signer, 'estimateGas');
    await signer.sendTransaction({ to: RECIPIENT, gasLimit: 21_000 });
    expect(estimate.called).to.equal(false);
    expect(send.calledOnce).to.equal(true);
    expect(BigNumber.from(send.firstCall.args[0].gasLimit).toNumber()).to.equal(
      21_000,
    );
    expect(requests).to.have.length(0);
  });

  it('shares client initialization across concurrent reads and refreshes replay metadata', async () => {
    const sign = sinon.spy(wallet, '_signTypedData');
    await Promise.all([
      signer.signedCall({ to: RECIPIENT, data: DATA }),
      signer.estimateGas({ to: RECIPIENT, data: DATA }),
    ]);
    rpcNonce = 8;
    rpcBlockNumber = 101;
    await signer.signedCall({ to: RECIPIENT, data: DATA });
    expect(
      requests.filter(({ method }) => method === 'seismic_getTeePublicKey'),
    ).to.have.length(1);
    expect(sign.lastCall.args[2]).to.include({
      nonce: 8n,
      expiresAtBlock: 201n,
    });
    const messages = sign.getCalls().map((call) => call.args[2]);
    expect(new Set(messages.map((m) => m.encryptionNonce)).size).to.equal(3);
    expect(new Set(messages.map((m) => m.encryptionPubkey)).size).to.equal(1);
  });

  it('retries client initialization after a failed TEE-key lookup', async () => {
    send
      .withArgs('seismic_getTeePublicKey')
      .onFirstCall()
      .rejects(new Error('TEE lookup unavailable'));
    await expect(signer.signedCall({ to: RECIPIENT })).to.be.rejectedWith(
      'TEE lookup unavailable',
    );
    expect(await signer.signedCall({ to: RECIPIENT })).to.equal(callResult);
    expect(send.withArgs('seismic_getTeePublicKey').callCount).to.equal(2);
  });

  it('uses the newly connected provider and initializes a separate client', async () => {
    await signer.signedCall({ to: RECIPIENT });
    const nextProvider = new providers.StaticJsonRpcProvider(
      'https://next.example',
      { chainId: CHAIN_ID, name: 'seismic' },
    );
    const nextSend = sinon.stub(nextProvider, 'send').callsFake(send);
    const next = signer.connect(nextProvider);
    expect(await next.signedCall({ to: RECIPIENT })).to.equal(callResult);
    expect(nextSend.called).to.equal(true);
    expect(
      requests.filter(({ method }) => method === 'seismic_getTeePublicKey'),
    ).to.have.length(2);
  });

  it('reinitializes the client when the inner signer changes accounts', async () => {
    await signer.estimateGas({ to: RECIPIENT });
    const other = Wallet.createRandom();
    sinon.stub(wallet, 'getAddress').resolves(other.address);
    const sign = sinon
      .stub(wallet, '_signTypedData')
      .callsFake(other._signTypedData.bind(other));
    await signer.estimateGas({ to: RECIPIENT });
    const [domain, types, message] = sign.lastCall.args;
    expect(
      utils.verifyTypedData(
        domain,
        types,
        message,
        await sign.lastCall.returnValue,
      ),
    ).to.equal(other.address);
    expect(
      requests.filter(({ method }) => method === 'seismic_getTeePublicKey'),
    ).to.have.length(2);
  });

  it('rejects a missing or non-RPC provider without using the metadata URL', async () => {
    for (const inner of [
      Wallet.createRandom(),
      wallet.connect(new providers.BaseProvider(CHAIN_ID)),
    ]) {
      const disconnected = new SeismicSigner(inner, {
        chainId: CHAIN_ID,
        rpcUrl: 'https://seismic.example',
        name: 'seismic',
      });
      await expect(
        disconnected.signedCall({ to: RECIPIENT }),
      ).to.be.rejectedWith('provider with JSON-RPC send support');
    }
    expect(requests).to.have.length(0);
  });

  it('keeps authenticated reads on the wrapped SmartProvider when its first RPC fails', async () => {
    const smart = new HyperlaneSmartProvider(
      { chainId: CHAIN_ID, name: 'seismic' },
      [{ http: 'https://first.example' }, { http: 'https://second.example' }],
    );
    const first = sinon.stub(smart.rpcProviders[0], 'send').callsFake(send);
    first.withArgs('eth_call').rejects(new Error('first RPC unavailable'));
    const second = sinon.stub(smart.rpcProviders[1], 'send').callsFake(send);
    const wrapped = signer.connect(smart);
    expect(await wrapped.signedCall({ to: RECIPIENT, data: DATA })).to.equal(
      callResult,
    );
    expect(second.withArgs('eth_call').calledOnce).to.equal(true);
    const call = second.withArgs('eth_call').firstCall.args[1];
    expect(call[0]).to.have.keys('data', 'signature');
    expect(call[1]).to.equal('latest');
  });

  for (const method of ['signedCall', 'estimateGas'] as const) {
    it(`exposes decrypted Error(string) as CALL_EXCEPTION for ${method}`, async () => {
      revertData =
        '0x08c379a0' +
        utils.defaultAbiCoder
          .encode(['string'], ['SUSDC: caller is not account'])
          .slice(2);
      try {
        await signer[method]({ to: RECIPIENT, data: DATA });
        expect.fail('Expected revert');
      } catch (error) {
        expect(error).to.include({
          code: 'CALL_EXCEPTION',
          reason: 'SUSDC: caller is not account',
          data: revertData,
        });
      }
    });
  }

  it('preserves custom-error bytes without inventing a revert reason', async () => {
    revertData =
      '0x12345678' + utils.defaultAbiCoder.encode(['uint256'], [9]).slice(2);
    await expect(
      signer.signedCall({ to: RECIPIENT }),
    ).to.be.rejected.and.eventually.include({
      code: 'CALL_EXCEPTION',
      reason: null,
      data: revertData,
    });
  });

  it('decrypts SmartProvider reverts without falling through to another RPC', async () => {
    const smart = new HyperlaneSmartProvider(
      { chainId: CHAIN_ID, name: 'seismic' },
      [{ http: 'https://first.example' }, { http: 'https://second.example' }],
      [],
      { maxRetries: 3, baseRetryDelayMs: 1 },
    );
    sinon.stub(smart.rpcProviders[0], 'send').callsFake(send);
    const second = sinon.stub(smart.rpcProviders[1], 'send').callsFake(send);
    revertData =
      '0x08c379a0' +
      utils.defaultAbiCoder.encode(['string'], ['not permitted']).slice(2);
    await expect(
      signer.connect(smart).signedCall({ to: RECIPIENT }),
    ).to.be.rejected.and.eventually.include({
      code: 'CALL_EXCEPTION',
      reason: 'not permitted',
      data: revertData,
    });
    expect(second.called).to.equal(false);
    expect(send.withArgs('eth_call').calledOnce).to.equal(true);
  });

  it('does not label undecryptable revert data as a decrypted contract error', async () => {
    callError = Object.assign(new Error('unreadable revert'), {
      code: 3,
      data: '0xdeadbeef',
    });
    try {
      await signer.signedCall({ to: RECIPIENT });
      expect.fail('Expected revert');
    } catch (error) {
      expect(error).not.to.have.property('code', 'CALL_EXCEPTION');
    }
  });

  it('leaves transport errors as transport errors', async () => {
    callError = new Error('RPC connection unavailable');
    try {
      await signer.signedCall({ to: RECIPIENT });
      expect.fail('Expected transport failure');
    } catch (error) {
      expect(error).not.to.have.property('code', 'CALL_EXCEPTION');
      expect(String(error)).to.contain('RPC connection unavailable');
    }
  });
});
