import { expect } from 'chai';

import {
  type CoreConfig,
  HookType,
  type ProtocolFeeHookConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import {
  CHAIN_NAME_1,
  CORE_CONFIG_PATH,
  CORE_READ_CONFIG_PATH_1,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TRON_KEY,
} from '../consts.js';

describe('hyperlane core deploy e2e tests (Tron)', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum, // Tron uses Ethereum protocol type with technicalStack: tron
    CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH,
    CORE_READ_CONFIG_PATH_1,
  );

  describe('hyperlane core deploy --yes --key ...', () => {
    it('should deploy core contracts with protocolFee hook', async () => {
      await hyperlaneCore.deploy(TRON_KEY);

      const coreConfig: CoreConfig = await hyperlaneCore.readConfig();

      // Verify owner is set correctly (example config uses hardhat test address)
      // The actual owner will be the signer address
      expect(coreConfig.owner).to.be.a('string');
      expect(coreConfig.proxyAdmin?.owner).to.be.a('string');

      // Verify defaultHook is protocolFee (from example config)
      const defaultHook = coreConfig.defaultHook as Exclude<
        CoreConfig['defaultHook'],
        string
      >;
      expect(defaultHook.type).to.equal(HookType.PROTOCOL_FEE);

      // Verify requiredHook is protocolFee
      const requiredHook = coreConfig.requiredHook as ProtocolFeeHookConfig;
      expect(requiredHook.type).to.equal(HookType.PROTOCOL_FEE);
    });
  });
});
