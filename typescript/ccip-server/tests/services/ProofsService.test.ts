import { describe, expect, jest, test } from '@jest/globals';
import { ethers } from 'ethers';

import ETH_GET_PROOFS from '../../../../solidity/test/test-data/getProof-data.json';
import { ProofsService } from '../../src/services/ProofsService';

// Fixtures
jest.mock('../../src/services/HyperlaneService');
jest.mock('../../src/services/LightClientService');
jest.mock('../../src/services/RPCService');

describe('ProofsService', () => {
  const TARGET_ADDR = 'targetAddress';
  const MESSAGE_ID = 'msgId';
  const STORAGE_KEY = ethers.utils.formatBytes32String('10');
  const PENDING_PROOF_ID = 'pendingProofId12';
  let proofsService: ProofsService;
  let pendingProofKey: string;

  beforeEach(() => {
    proofsService = new ProofsService(
      {
        lightClientAddress: ethers.constants.AddressZero,
        stepFunctionId: ethers.constants.HashZero,
        platformUrl: 'http://localhost:8080',
        apiKey: 'apiKey',
        chainId: '1337',
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
    // We need to try-catch because of forceRevert()
    try {
      await proofsService.getProofs([TARGET_ADDR, STORAGE_KEY, MESSAGE_ID]);
    } catch (e: any) {
      expect(e.message).toBe('Proof is not ready');
      expect(proofsService.pendingProof.get(pendingProofKey)).toEqual(
        PENDING_PROOF_ID,
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
        PENDING_PROOF_ID,
      );
    } catch (e) {
      // Try to get the proof again
      const proofs = await proofsService.getProofs([
        TARGET_ADDR,
        STORAGE_KEY,
        MESSAGE_ID,
      ]);
      expect(proofs[0][1]).toEqual([ETH_GET_PROOFS.storageProof[0].proof[0]]);
      expect(proofsService.pendingProof.get(pendingProofKey)).toBeUndefined();
    }
  });
});
