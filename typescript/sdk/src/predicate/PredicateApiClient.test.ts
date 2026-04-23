import { expect } from 'vitest';
import sinon from 'sinon';

import {
  PredicateApiClient,
  PredicateAttestationRequest,
  PredicateAttestationResponse,
} from './PredicateApiClient.js';

describe('PredicateApiClient', () => {
  let fetchStub: sinon.SinonStub;

  const mockRequest: PredicateAttestationRequest = {
    to: '0x1234567890123456789012345678901234567890',
    from: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    data: '0x',
    msg_value: '0',
    chain: 'sepolia',
  };

  const mockResponse: PredicateAttestationResponse = {
    policy_id: 'policy_abc123',
    policy_name: 'Test Policy',
    verification_hash: 'x-test-hash',
    is_compliant: true,
    attestation: {
      uuid: '550e8400-e29b-41d4-a716-446655440000',
      expiration: Math.floor(Date.now() / 1000) + 3600,
      attester: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      signature: '0x1234abcd',
    },
  };

  beforeEach(() => {
    fetchStub = sinon.stub(global, 'fetch');
  });

  afterEach(() => {
    fetchStub.restore();
  });

  it('should fetch attestation successfully', async () => {
    fetchStub.resolves({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const client = new PredicateApiClient('test-api-key');
    const result = await client.fetchAttestation(mockRequest);

    expect(result.is_compliant).toBe(true);
    expect(result.attestation.uuid).toBe(mockResponse.attestation.uuid);
    expect(fetchStub.calledOnce).toBe(true);
  });

  it('should throw on non-compliant response', async () => {
    fetchStub.resolves({
      ok: true,
      json: async () => ({ ...mockResponse, is_compliant: false }),
    } as Response);

    const client = new PredicateApiClient('test-api-key');

    try {
      await client.fetchAttestation(mockRequest);
      throw new Error('Expected error to be thrown');
    } catch (error: any) {
      expect(error.message).toContain('Transaction not compliant');
    }
  });

  it('should throw on API error', async () => {
    fetchStub.resolves({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    } as Response);

    const client = new PredicateApiClient('test-api-key');

    try {
      await client.fetchAttestation(mockRequest);
      throw new Error('Expected error to be thrown');
    } catch (error: any) {
      expect(error.message).toContain('Predicate API error (401)');
      expect(error.message).toContain('Unauthorized');
    }
  });

  it('should use custom base URL', async () => {
    fetchStub.resolves({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const customUrl = 'https://custom.predicate.io/v2/attestation';
    const client = new PredicateApiClient('test-api-key', customUrl);
    await client.fetchAttestation(mockRequest);

    expect(fetchStub.firstCall.args[0]).toBe(customUrl);
  });

  it('should include API key in headers', async () => {
    fetchStub.resolves({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const client = new PredicateApiClient('my-secret-key');
    await client.fetchAttestation(mockRequest);

    const callArgs = fetchStub.firstCall.args[1] as RequestInit;
    expect((callArgs.headers as Record<string, string>)['x-api-key']).toBe(
      'my-secret-key',
    );
  });

  it('should send correct request body', async () => {
    fetchStub.resolves({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const client = new PredicateApiClient('test-api-key');
    await client.fetchAttestation(mockRequest);

    const callArgs = fetchStub.firstCall.args[1] as RequestInit;
    const body = JSON.parse(callArgs.body as string);

    expect(body.to).toBe(mockRequest.to);
    expect(body.from).toBe(mockRequest.from);
    expect(body.data).toBe(mockRequest.data);
    expect(body.msg_value).toBe(mockRequest.msg_value);
    expect(body.chain).toBe(mockRequest.chain);
  });
});
