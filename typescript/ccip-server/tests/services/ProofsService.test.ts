import { describe, expect, jest, test, beforeEach } from '@jest/globals';
import { ethers } from 'ethers';

import { ProofsService } from '../../src/services/ProofsService.js';
import { ProofsServiceAbi } from '../../src/abis/ProofsServiceAbi.js';

describe('ProofsService', () => {
  const TARGET_ADDR = '0x7DDf66a264656A36eB0Ff4bC6eC562028B983B90';
  const STORAGE_KEY = '0x66ce4e8e12a5403828e3fb3176b429cb926ef9dc29fd04c1b3c13ed2787d98d6';
  const SLOT = '1000';
  const BLOCK_NUMBER = 2151871;

  let proofsService: ProofsService;

  beforeEach(() => {
    process.env.RPC_ADDRESS = 'http://localhost:8545';
    process.env.CONSENSUS_API_URL = 'http://localhost:5052/eth/v2/beacon/blocks';

    proofsService = new ProofsService({ serviceName: 'proofs' });

    proofsService.consensusService.getOriginBlockNumberBySlot = jest
      .fn<() => Promise<number>>()
      .mockResolvedValue(BLOCK_NUMBER);

    proofsService.rpcService.getProofs = jest.fn<any>().mockResolvedValue({
      accountProof: ['0xacct1', '0xacct2'],
      storageProof: [
        {
          key: STORAGE_KEY,
          value: '0xval',
          proof: ['0xstorage1'],
        },
      ],
      address: TARGET_ADDR,
      balance: '0x0',
      codeHash: '0x0',
      nonce: '0x1',
      storageHash: '0x0',
    });
  });

  test('getProofs returns account and storage proofs', async () => {
    const proofs = await proofsService.getProofs(TARGET_ADDR, STORAGE_KEY, SLOT);

    expect(proofsService.consensusService.getOriginBlockNumberBySlot).toHaveBeenCalledWith(
      SLOT,
    );
    expect(proofsService.rpcService.getProofs).toHaveBeenCalledWith(
      TARGET_ADDR,
      [STORAGE_KEY],
      `0x${BLOCK_NUMBER.toString(16)}`,
    );

    expect(proofs).toEqual([
      ['0xacct1', '0xacct2'],
      ['0xstorage1'],
    ]);
  });

  test('ABI encodes and decodes getProofs correctly', () => {
    const iface = new ethers.utils.Interface(ProofsServiceAbi);
    const callData = iface.encodeFunctionData('getProofs', [
      TARGET_ADDR,
      STORAGE_KEY,
      SLOT,
    ]);

    const decoded = iface.decodeFunctionData('getProofs', callData);
    expect(decoded[0].toLowerCase()).toEqual(TARGET_ADDR.toLowerCase());
    expect(decoded[1]).toEqual(STORAGE_KEY);
    expect(decoded[2].toString()).toEqual(SLOT);
  });
});
