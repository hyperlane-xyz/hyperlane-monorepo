import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { BigNumber, Wallet, utils } from 'ethers';
import {
  AesGcmCrypto,
  AesKeyDomain,
  encodeSeismicMetadataAsAAD,
  generateAesKey,
} from 'seismic-viem';
import sinon from 'sinon';
import { isHex } from 'viem';
import { z } from 'zod';

import { assert } from '@hyperlane-xyz/utils';

import { SeismicSigner } from './SeismicSigner.js';

const CHAIN_ID = 5124;
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const SERVER_KEY = `0x${'01'.repeat(32)}`;
const BLOCK_GAS_LIMIT = 45_000_000;
const RECIPIENT = '0x0000000000000000000000000000000000000012';
const DATA = '0x12345678';

chai.use(chaiAsPromised);

describe('SeismicSigner', () => {
  let wallet: Wallet;
  let signer: SeismicSigner;
  let requests: { method: string; params?: unknown[] }[];
  let rpcChainId: number;
  let estimateError: string | undefined;

  beforeEach(() => {
    wallet = Wallet.createRandom();
    signer = new SeismicSigner(wallet, {
      chainId: CHAIN_ID,
      rpcUrl: 'https://seismic.example',
      name: 'seismic',
    });
    requests = [];
    rpcChainId = CHAIN_ID;
    estimateError = undefined;
    sinon.stub(globalThis, 'fetch').callsFake(async (_url, init) => {
      assert(typeof init?.body === 'string', 'Expected JSON-RPC body');
      const request = z
        .object({
          id: z.number(),
          method: z.string(),
          params: z.array(z.unknown()).optional(),
        })
        .parse(JSON.parse(init.body));
      requests.push(request);
      const results: Record<string, unknown> = {
        seismic_getTeePublicKey: utils.computePublicKey(SERVER_KEY, true),
        eth_chainId: utils.hexValue(rpcChainId),
        eth_getTransactionCount: '0x7',
        eth_getBlockByNumber: {
          hash: BLOCK_HASH,
          number: '0x64',
          gasLimit: utils.hexValue(BLOCK_GAS_LIMIT),
          transactions: [],
        },
        eth_estimateGas: '0x12345',
      };
      assert(request.method in results, `Unexpected RPC ${request.method}`);
      const body =
        request.method === 'eth_estimateGas' && estimateError
          ? { error: { code: -32602, message: estimateError } }
          : { result: results[request.method] };
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: request.id, ...body }),
        { headers: { 'Content-Type': 'application/json' } },
      );
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
});
