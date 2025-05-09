import { promises as fs } from 'fs';
import { join } from 'path';
import { CompiledContract } from 'starknet';

import { CONTRACT_SUFFIXES } from '../src/const.js';
import { ContractType } from '../src/types.js';

const TEST_CONTRACTS = [
  { name: 'contracts_Test', type: ContractType.CONTRACT },
  { name: 'token_HypERC20', type: ContractType.TOKEN },
  { name: 'mocks_MockContract', type: ContractType.MOCK },
];

export function createMockSierraArtifact(): CompiledContract {
  return {
    contract_class_version: '0.1.0',
    entry_points_by_type: {
      EXTERNAL: [
        {
          selector:
            '0x52580a92c73f4428f1a260c5d768ef462b25955307de00f99957df119865d',
          function_idx: 11,
        },
      ],
      L1_HANDLER: [],
      CONSTRUCTOR: [
        {
          selector:
            '0x28ffe4ff0f226a9107253e17a904099aa4f63a02a5621de0576e5aa71bc5194',
          function_idx: 12,
        },
      ],
    },
    abi: [
      {
        type: 'interface',
        name: 'contracts::interfaces::IInterchainSecurityModule',
        items: [
          {
            type: 'function',
            name: 'verify',
            inputs: [
              {
                name: '_metadata',
                type: 'alexandria_bytes::bytes::Bytes',
              },
              {
                name: '_message',
                type: 'contracts::libs::message::Message',
              },
            ],
            outputs: [{ type: 'core::bool' }],
            state_mutability: 'view',
          },
        ],
      },
      {
        type: 'function',
        name: 'test_function',
        inputs: [],
        outputs: [{ type: 'felt' }],
      },
    ],
    sierra_program: [],
  };
}

export async function createMockContractFiles(testReleaseDir: string) {
  for (const contract of TEST_CONTRACTS) {
    const filePath = join(
      testReleaseDir,
      `${contract.name}${CONTRACT_SUFFIXES.SIERRA_JSON}`,
    );
    await fs.writeFile(filePath, JSON.stringify(createMockSierraArtifact()));
  }
}
