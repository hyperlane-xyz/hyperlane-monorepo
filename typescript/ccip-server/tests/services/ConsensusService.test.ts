import { expect } from 'chai';
import sinon from 'sinon';

import { ConsensusService } from '../../src/services/ConsensusService.js';

describe('ConsensusService', () => {
  const CONSENSUS_URL = 'http://localhost:5052/eth/v2/beacon/blocks';
  let consensusService: ConsensusService;

  beforeEach(() => {
    consensusService = new ConsensusService(CONSENSUS_URL);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('getOriginBlockNumberBySlot parses block number from beacon response', async () => {
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

    const fetchStub = sinon.stub(global, 'fetch' as any).resolves({
      ok: true,
      json: async () => mockResponse,
    } as any);

    const blockNumber =
      await consensusService.getOriginBlockNumberBySlot('1000');
    expect(blockNumber).to.equal(2151871);
    expect(fetchStub.calledWith(`${CONSENSUS_URL}/1000`)).to.be.true;
  });
});
