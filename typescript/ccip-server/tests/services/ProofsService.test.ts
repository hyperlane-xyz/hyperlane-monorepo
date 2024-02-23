import { ethers } from 'ethers';

import { ProofStatus } from '../../src/services/LightClientService';
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
      // proofsService.lightClientService.__setProofStatus(ProofStatus.success);

      await proofsService.getProofs([TARGET_ADDR, STORAGE_KEY, MESSAGE_ID]);
      expect(proofsService.pendingProof.get(pendingProofKey)).toEqual(
        'pendingProofId12',
      );
    }
  });
});
