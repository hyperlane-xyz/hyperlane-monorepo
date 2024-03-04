import { describe, expect, jest, test } from '@jest/globals';
import { ethers } from 'ethers';

// import { LightClientService } from '../../src/services/LightClientService';
import { ProofsService } from '../../src/services/ProofsService';

// Fixtures
jest.mock('../../src/services/HyperlaneService');
jest.mock('../../src/services/LightClientService');
jest.mock('../../src/services/RPCService');

describe('ProofsService', () => {
  const TARGET_ADDR = 'targetAddress';
  const MESSAGE_ID = 'msgId';
  const STORAGE_KEY = ethers.utils.formatBytes32String('10');
  let proofsService: ProofsService;
  let pendingProofKey: string;

  beforeEach(() => {
    proofsService = new ProofsService(
      {
        lightClientAddress: ethers.constants.AddressZero,
        stepFunctionId: ethers.constants.HashZero,
        platformUrl: 'http://localhost:8080',
        apiKey: 'apiKey',
      },
      {
        url: 'http://localhost:8545',
        chainId: '1337',
      },
      {
        url: 'http://localhost:8545',
      },
    );
    pendingProofKey = proofsService.getPendingProofKey(
      TARGET_ADDR,
      STORAGE_KEY,
      MESSAGE_ID,
    );
    jest.clearAllMocks();
  });

  test('should set currentProofId, if proof is not ready', async () => {
    try {
      await proofsService.getProofs([TARGET_ADDR, STORAGE_KEY, MESSAGE_ID]);
    } catch (e) {
      expect(proofsService.pendingProof.get(pendingProofKey)).toEqual(
        'pendingProofId12',
      );
    }
  });

  test('should reset currentProofId, if proof is ready', async () => {
    const pendingProofKey = proofsService.getPendingProofKey(
      TARGET_ADDR,
      STORAGE_KEY,
      MESSAGE_ID,
    );
    try {
      await proofsService.getProofs([TARGET_ADDR, STORAGE_KEY, MESSAGE_ID]);
      expect(proofsService.pendingProof.get(pendingProofKey)).toEqual(
        'pendingProofId12',
      );
    } catch (e) {
      // Try to get the proof again
      const proofs = await proofsService.getProofs([
        TARGET_ADDR,
        STORAGE_KEY,
        MESSAGE_ID,
      ]);
      expect(proofs[0][1]).toEqual([
        '0xf844a120443dd0be11dd8e645a2e5675fd62011681443445ea8b04c77d2cdeb1326739eca1a031ede38d2e93c5aee49c836f329a626d8c6322abfbff3783e82e5759f870d7e9',
      ]);
      expect(proofsService.pendingProof.get(pendingProofKey)).toBeUndefined();
    }
  });
});
