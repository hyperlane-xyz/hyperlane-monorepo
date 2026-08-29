import { describe, expect, jest, test, beforeEach } from '@jest/globals';

import { ConsensusService } from '../../src/services/ConsensusService.js';

describe('ConsensusService', () => {
  const CONSENSUS_URL = 'http://localhost:5052/eth/v2/beacon/blocks';
  let consensusService: ConsensusService;

  beforeEach(() => {
    consensusService = new ConsensusService(CONSENSUS_URL);
  });

  test('getOriginBlockNumberBySlot parses block number from beacon response', async () => {
    const mockResponse = {
      data: {
        message: {
          body: {
            execution_payload: {
              block_number: 2151871,
            },
          },
        },
      },
    };

    global.fetch = jest.fn<any>().mockResolvedValue({
      ok: true,
      json: jest.fn<any>().mockResolvedValue(mockResponse),
    });

    const blockNumber = await consensusService.getOriginBlockNumberBySlot('1000');
    expect(blockNumber).toEqual(2151871);
    expect(global.fetch).toHaveBeenCalledWith(`${CONSENSUS_URL}/1000`);
  });
});
