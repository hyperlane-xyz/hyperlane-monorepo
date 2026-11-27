import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { TestChainName } from '../../../../consts/testChains.js';
import { MultiProvider } from '../../../MultiProvider.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';
import { getSubmitter } from '../submitterBuilderGetter.js';

import { EvmAccessManagerSubmitterProps } from './types.js';

chai.use(chaiAsPromised);

describe('EV5AccessManagerSubmitter.fromConfig', () => {
  const chain = TestChainName.test1;
  const ACCESS_MANAGER_MOCK: Address =
    '0x3D079E977d644c914a344Dcb5Ba54dB243Cc4863';
  const HASH_16_BYTES_MOCK: Address = '0x12345678901234567890123456789012';

  function buildConfig(fields: {
    accessManagerAddress: Address;
    caller?: Address;
  }): EvmAccessManagerSubmitterProps {
    return {
      type: TxSubmitterType.ACCESS_MANAGER,
      chain,
      accessManagerAddress: fields.accessManagerAddress,
      caller: fields.caller,
      proposerSubmitter: { type: TxSubmitterType.JSON_RPC, chain },
    };
  }

  const cases: Array<{
    name: string;
    config: EvmAccessManagerSubmitterProps;
    expectedError: string;
  }> = [
    {
      name: 'the accessManagerAddress is a 16-byte value',
      config: buildConfig({ accessManagerAddress: HASH_16_BYTES_MOCK }),
      expectedError: `AccessManager address ${HASH_16_BYTES_MOCK} on ${chain} must be a valid EVM address`,
    },
    {
      name: 'the caller is a 16-byte value',
      config: buildConfig({
        accessManagerAddress: ACCESS_MANAGER_MOCK,
        caller: HASH_16_BYTES_MOCK,
      }),
      expectedError: `AccessManager caller ${HASH_16_BYTES_MOCK} on ${chain} must be a valid EVM address`,
    },
  ];

  for (const { name, config, expectedError } of cases) {
    it(`should reject the config when ${name}`, async () => {
      await expect(
        getSubmitter<ProtocolType.Ethereum>(
          MultiProvider.createTestMultiProvider(),
          config,
          {},
        ),
      ).to.be.rejectedWith(expectedError);
    });
  }

  it('should accept addresses with a bad EIP-55 checksum', async () => {
    // Mixed-case casings with a wrong checksum of ACCESS_MANAGER_MOCK and
    // 0x32e02dDB233958834fcB5E93b11E254F8D1EAd1b
    const submitter = await getSubmitter<ProtocolType.Ethereum>(
      MultiProvider.createTestMultiProvider(),
      buildConfig({
        accessManagerAddress: '0x3d079E977d644c914a344Dcb5Ba54dB243Cc4863',
        caller: '0x32E02dDB233958834fcB5E93b11E254F8D1EAd1b',
      }),
      {},
    );

    expect(submitter.txSubmitterType).to.equal(TxSubmitterType.ACCESS_MANAGER);
  });
});
