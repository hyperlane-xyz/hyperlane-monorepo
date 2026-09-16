import { expect } from 'chai';
import { ethers, Wallet } from 'ethers';

import { HttpMethod, Web2Request, Web2Response } from './types.js';
import { Web2Message } from './Web2Message.js';
import { Web2Keeper } from './Web2Keeper.js';

describe('Web2Message', () => {
  const dummyRequestId = ethers.utils.id('test-request-1');
  const dummySender = ethers.utils.hexZeroPad(
    '0x1234567890123456789012345678901234567890',
    32,
  );
  const dummyCallback = ethers.utils.hexZeroPad(
    '0x0987654321098765432109876543210987654321',
    32,
  );

  it('should encode and decode Web2 requests accurately', () => {
    const request: Web2Request = {
      requestId: dummyRequestId,
      sender: dummySender,
      method: HttpMethod.POST,
      url: 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
      headers: '{"Content-Type":"application/json"}',
      body: '0x123456',
      callbackAddress: dummyCallback,
      callbackData: '0xabcdef',
    };

    const encoded = Web2Message.encodeRequest(request);
    expect(encoded).to.be.a('string');

    const decoded = Web2Message.decodeRequest(encoded);
    expect(decoded.requestId).to.equal(request.requestId);
    expect(decoded.sender.toLowerCase()).to.equal(request.sender.toLowerCase());
    expect(decoded.method).to.equal(request.method);
    expect(decoded.url).to.equal(request.url);
    expect(decoded.headers).to.equal(request.headers);
    expect(decoded.body).to.equal(request.body);
    expect(decoded.callbackAddress.toLowerCase()).to.equal(
      request.callbackAddress.toLowerCase(),
    );
    expect(decoded.callbackData).to.equal(request.callbackData);
  });

  it('should encode and decode Web2 responses accurately', () => {
    const response: Web2Response = {
      requestId: dummyRequestId,
      callbackAddress: dummyCallback,
      statusCode: 200,
      headers: '{"server":"cloudflare"}',
      responseBody: '0xdeadbeef',
      callbackData: '0xcafe',
    };

    const encoded = Web2Message.encodeResponse(response);
    const decoded = Web2Message.decodeResponse(encoded);

    expect(decoded.requestId).to.equal(response.requestId);
    expect(decoded.callbackAddress.toLowerCase()).to.equal(
      response.callbackAddress.toLowerCase(),
    );
    expect(decoded.statusCode).to.equal(200);
    expect(decoded.headers).to.equal(response.headers);
    expect(decoded.responseBody).to.equal(response.responseBody);
    expect(decoded.callbackData).to.equal(response.callbackData);
  });

  it('should format ISM metadata matching Web2SecurityModule expectations', () => {
    const endpointHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes('https://api.example.com'),
    );
    const timestamp = 1700000000;
    const sig1 = '0x' + '11'.repeat(65);
    const sig2 = '0x' + '22'.repeat(65);

    const metadata = Web2Message.formatIsmMetadata({
      endpointHash,
      timestamp,
      requestId: dummyRequestId,
      signatures: [sig1, sig2],
    });

    const metadataBytes = ethers.utils.arrayify(metadata);
    // 32 bytes endpointHash + 8 bytes timestamp + 32 bytes requestId + 2 * 65 bytes signatures = 202 bytes
    expect(metadataBytes.length).to.equal(32 + 8 + 32 + 130);
  });
});

describe('Web2Keeper', () => {
  const wallet1 = Wallet.createRandom();
  const wallet2 = Wallet.createRandom();

  const keeper = new Web2Keeper({
    originDomain: 123,
    web2Domain: 999,
    routerAddress: '0x1111111111111111111111111111111111111111',
    mailboxAddress: '0x2222222222222222222222222222222222222222',
    privateKeys: [wallet1.privateKey, wallet2.privateKey],
  });

  it('should generate valid multi-signer attestations and metadata', async () => {
    const request: Web2Request = {
      requestId: ethers.utils.id('req-keeper-test'),
      sender: ethers.utils.hexZeroPad(
        '0x1234567890123456789012345678901234567890',
        32,
      ),
      method: HttpMethod.GET,
      url: 'https://api.coingecko.com/api/v3/ping',
      headers: '{}',
      body: '0x',
      callbackAddress: ethers.utils.hexZeroPad(
        '0x0987654321098765432109876543210987654321',
        32,
      ),
      callbackData: '0x12',
    };

    const httpResult = {
      statusCode: 200,
      headers: '{"status":"ok"}',
      body: new Uint8Array([1, 2, 3, 4]),
    };

    const attestation = await keeper.generateAttestation({
      request,
      httpResult,
      destinationDomain: 123,
      recipientRouterAddress: '0x1111111111111111111111111111111111111111',
    });

    expect(attestation.response.statusCode).to.equal(200);
    expect(attestation.metadata).to.be.a('string');
    expect(attestation.digest).to.be.a('string');
  });
});
