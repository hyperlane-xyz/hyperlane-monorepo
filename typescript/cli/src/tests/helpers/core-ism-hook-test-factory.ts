import { expect } from 'chai';

import {
  type CoreConfig,
  type DerivedCoreConfig,
  type DerivedIsmConfig,
  HookType,
  type IsmConfig,
  IsmType,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { type Address, assert, normalizeAddress } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../utils/files.js';
import { type HyperlaneE2ECoreTestCommands } from '../commands/core.js';

/**
 * Configuration for core ISM/Hook update test suite
 */
export interface CoreUpdateTestConfig {
  chainName: string;
  baseCoreConfigPath: string;
  coreApplyConfigPath: string;
  privateKey: string;
  alternateOwnerAddress: Address;
}

type HookField = 'defaultHook' | 'requiredHook';

type RoutingDerivedIsm = DerivedIsmConfig & {
  domains: Record<string, unknown>;
};

function hasDomains(value: DerivedIsmConfig): value is RoutingDerivedIsm {
  return typeof value === 'object' && value !== null && 'domains' in value;
}

function getRoutingDomainIsmAddress(
  routingIsm: DerivedIsmConfig,
  chainName: string,
): string {
  assert(
    hasDomains(routingIsm),
    `Expected routing ISM to contain domains for chain ${chainName}`,
  );
  const domainIsm = routingIsm.domains[chainName];
  assert(
    typeof domainIsm !== 'string' &&
      typeof domainIsm === 'object' &&
      domainIsm !== null &&
      'address' in domainIsm,
    `Expected routing ISM domain ${chainName} to be a derived ISM with an address`,
  );
  const { address } = domainIsm;
  assert(
    typeof address === 'string',
    `Expected routing ISM domain ${chainName} address to be a string`,
  );
  return address;
}

/**
 * Creates a reusable ISM and Hook update test suite for core deployments.
 * Each test deploys a fresh core to ensure isolation.
 */
export function createCoreUpdateTests(
  config: CoreUpdateTestConfig,
  coreCommands: HyperlaneE2ECoreTestCommands,
): void {
  describe('Core ISM updates', () => {
    beforeEach(async () => {
      // Deploy fresh core for each test
      const baseCoreConfig: CoreConfig = readYamlOrJson(
        config.baseCoreConfigPath,
      );
      writeYamlOrJson(config.coreApplyConfigPath, baseCoreConfig);
      coreCommands.setCoreInputPath(config.coreApplyConfigPath);
      await coreCommands.deploy(config.privateKey);
    });

    it('should update defaultIsm from testIsm to messageIdMultisigIsm', async function () {
      // First apply with testIsm
      const coreConfig: CoreConfig = readYamlOrJson(config.baseCoreConfigPath);
      coreConfig.defaultIsm = {
        type: IsmType.TEST_ISM,
      };
      writeYamlOrJson(config.coreApplyConfigPath, coreConfig);
      await coreCommands.apply(config.privateKey);

      // Update to messageIdMultisigIsm
      const newIsmConfig: IsmConfig = {
        type: IsmType.MESSAGE_ID_MULTISIG,
        validators: [randomAddress()],
        threshold: 1,
      };
      coreConfig.defaultIsm = newIsmConfig;
      writeYamlOrJson(config.coreApplyConfigPath, coreConfig);
      await coreCommands.apply(config.privateKey);

      // Verify
      const readConfig: DerivedCoreConfig = await coreCommands.readConfig();
      expect(readConfig.defaultIsm).to.not.be.a('string');
      const defaultIsm = readConfig.defaultIsm;
      expect(defaultIsm.type).to.equal(IsmType.MESSAGE_ID_MULTISIG);
      assert(
        defaultIsm.type === IsmType.MESSAGE_ID_MULTISIG,
        'ISM type should be MESSAGE_ID_MULTISIG',
      );
      expect(defaultIsm.address).to.be.a('string');
      expect(
        defaultIsm.validators.map((validator: string) =>
          normalizeAddress(validator),
        ),
      ).to.deep.equal(
        newIsmConfig.validators.map((validator: string) =>
          normalizeAddress(validator),
        ),
      );
    });

    it('should update routing ISM owner without redeployment (mutable)', async function () {
      // Deploy with routing ISM
      const coreConfig: CoreConfig = readYamlOrJson(config.baseCoreConfigPath);
      const initialRoutingIsmConfig: IsmConfig = {
        type: IsmType.ROUTING,
        owner: coreConfig.owner,
        domains: {
          [config.chainName]: {
            type: IsmType.TEST_ISM,
          },
        },
      };
      coreConfig.defaultIsm = initialRoutingIsmConfig;
      writeYamlOrJson(config.coreApplyConfigPath, coreConfig);
      await coreCommands.apply(config.privateKey);

      // Read to get ISM address
      let readConfig: DerivedCoreConfig = await coreCommands.readConfig();
      const initialDefaultIsm = readConfig.defaultIsm;
      expect(initialDefaultIsm.type).to.equal(IsmType.ROUTING);
      assert(
        initialDefaultIsm.type === IsmType.ROUTING,
        'defaultIsm should be ROUTING',
      );
      const initialIsmAddress = initialDefaultIsm.address;
      const initialDomainIsmAddress = getRoutingDomainIsmAddress(
        initialDefaultIsm,
        config.chainName,
      );

      // Update only owner (mutable)
      const updatedRoutingIsmConfig: IsmConfig = {
        type: IsmType.ROUTING,
        owner: config.alternateOwnerAddress,
        domains: {
          [config.chainName]: {
            type: IsmType.TEST_ISM,
          },
        },
      };
      coreConfig.defaultIsm = updatedRoutingIsmConfig;
      writeYamlOrJson(config.coreApplyConfigPath, coreConfig);
      await coreCommands.apply(config.privateKey);

      // Verify routing ISM address unchanged (updated in-place)
      readConfig = await coreCommands.readConfig();
      const updatedDefaultIsm = readConfig.defaultIsm;
      assert(
        updatedDefaultIsm.type === IsmType.ROUTING,
        'defaultIsm should be ROUTING',
      );
      expect(updatedDefaultIsm.address).to.equal(initialIsmAddress);
      expect(normalizeAddress(updatedDefaultIsm.owner)).to.equal(
        normalizeAddress(config.alternateOwnerAddress),
      );
      // Domain ISM should not be redeployed
      expect(
        getRoutingDomainIsmAddress(updatedDefaultIsm, config.chainName),
      ).to.equal(initialDomainIsmAddress);
    });

    it('should redeploy ISM when immutable config changes', async function () {
      // Deploy messageIdMultisigIsm with initial validators
      const coreConfig: CoreConfig = readYamlOrJson(config.baseCoreConfigPath);
      const initialValidators = [randomAddress()];
      coreConfig.defaultIsm = {
        type: IsmType.MESSAGE_ID_MULTISIG,
        validators: initialValidators,
        threshold: 1,
      };
      writeYamlOrJson(config.coreApplyConfigPath, coreConfig);
      await coreCommands.apply(config.privateKey);

      // Read to get ISM address
      const firstConfig: DerivedCoreConfig = await coreCommands.readConfig();
      const firstDefaultIsm: DerivedIsmConfig = firstConfig.defaultIsm;
      assert(
        firstDefaultIsm.type === IsmType.MESSAGE_ID_MULTISIG,
        'defaultIsm should be MESSAGE_ID_MULTISIG',
      );
      const firstIsmAddress = firstDefaultIsm.address;

      // Update validators (immutable field)
      const newValidators = [randomAddress()];
      coreConfig.defaultIsm = {
        type: IsmType.MESSAGE_ID_MULTISIG,
        validators: newValidators,
        threshold: 1,
      };
      writeYamlOrJson(config.coreApplyConfigPath, coreConfig);
      await coreCommands.apply(config.privateKey);

      // Verify ISM was redeployed (different address)
      const secondConfig: DerivedCoreConfig = await coreCommands.readConfig();
      const secondDefaultIsm: DerivedIsmConfig = secondConfig.defaultIsm;
      assert(
        secondDefaultIsm.type === IsmType.MESSAGE_ID_MULTISIG,
        'defaultIsm should be MESSAGE_ID_MULTISIG',
      );
      expect(secondDefaultIsm.address).to.not.equal(firstIsmAddress);
      expect(
        secondDefaultIsm.validators.map((validator: string) =>
          normalizeAddress(validator),
        ),
      ).to.deep.equal(
        newValidators.map((validator: string) => normalizeAddress(validator)),
      );
    });
  });

  describe('Core Hook updates', () => {
    beforeEach(async () => {
      // Deploy fresh core for each test
      const baseCoreConfig: CoreConfig = readYamlOrJson(
        config.baseCoreConfigPath,
      );
      writeYamlOrJson(config.coreApplyConfigPath, baseCoreConfig);
      coreCommands.setCoreInputPath(config.coreApplyConfigPath);
      await coreCommands.deploy(config.privateKey);
    });

    // Table-driven tests for both defaultHook and requiredHook
    const hookFields: HookField[] = ['defaultHook', 'requiredHook'];

    hookFields.forEach((hookField) => {
      describe(`${hookField} updates`, () => {
        it(`should update ${hookField} IGP owner (mutable)`, async function () {
          // Deploy with IGP hook
          const coreConfig: CoreConfig = readYamlOrJson(
            config.baseCoreConfigPath,
          );
          coreConfig[hookField] = {
            type: HookType.INTERCHAIN_GAS_PAYMASTER,
            owner: coreConfig.owner,
            beneficiary: coreConfig.owner,
            oracleKey: coreConfig.owner,
            overhead: {},
            oracleConfig: {},
          };
          writeYamlOrJson(config.coreApplyConfigPath, coreConfig);
          await coreCommands.apply(config.privateKey);

          // Read to get hook address
          let readConfig: DerivedCoreConfig = await coreCommands.readConfig();
          expect(readConfig[hookField]).to.not.be.a('string');
          expect(readConfig[hookField].type).to.equal(
            HookType.INTERCHAIN_GAS_PAYMASTER,
          );
          const hookAddress = readConfig[hookField].address;

          // Update owner (mutable)
          coreConfig[hookField] = {
            type: HookType.INTERCHAIN_GAS_PAYMASTER,
            owner: config.alternateOwnerAddress,
            beneficiary: coreConfig.owner,
            oracleKey: coreConfig.owner,
            overhead: {},
            oracleConfig: {},
          };
          writeYamlOrJson(config.coreApplyConfigPath, coreConfig);
          await coreCommands.apply(config.privateKey);

          // Verify hook address unchanged (updated in-place)
          readConfig = await coreCommands.readConfig();
          assert(
            readConfig[hookField].type === HookType.INTERCHAIN_GAS_PAYMASTER,
            `${hookField} should still be IGP`,
          );
          expect(readConfig[hookField].address).to.equal(hookAddress);
          expect(normalizeAddress(readConfig[hookField].owner)).to.equal(
            normalizeAddress(config.alternateOwnerAddress),
          );
        });

        it(`should redeploy ${hookField} when changing type (merkleTreeHook to IGP)`, async function () {
          // Deploy with merkleTreeHook
          const coreConfig: CoreConfig = readYamlOrJson(
            config.baseCoreConfigPath,
          );
          coreConfig[hookField] = {
            type: HookType.MERKLE_TREE,
          };
          writeYamlOrJson(config.coreApplyConfigPath, coreConfig);
          await coreCommands.apply(config.privateKey);

          // Read to get hook address
          const firstConfig: DerivedCoreConfig =
            await coreCommands.readConfig();
          const firstHookAddress = firstConfig[hookField].address;

          // Change to IGP hook (different type)
          coreConfig[hookField] = {
            type: HookType.INTERCHAIN_GAS_PAYMASTER,
            owner: coreConfig.owner,
            beneficiary: coreConfig.owner,
            oracleKey: coreConfig.owner,
            overhead: {},
            oracleConfig: {},
          };
          writeYamlOrJson(config.coreApplyConfigPath, coreConfig);
          await coreCommands.apply(config.privateKey);

          // Verify new hook deployed
          const secondConfig: DerivedCoreConfig =
            await coreCommands.readConfig();
          expect(secondConfig[hookField].address).to.not.equal(
            firstHookAddress,
          );
          expect(secondConfig[hookField].type).to.equal(
            HookType.INTERCHAIN_GAS_PAYMASTER,
          );
        });

        it(`should not redeploy ${hookField} when applying same IGP config twice`, async function () {
          // Deploy with IGP hook
          const coreConfig: CoreConfig = readYamlOrJson(
            config.baseCoreConfigPath,
          );
          coreConfig[hookField] = {
            type: HookType.INTERCHAIN_GAS_PAYMASTER,
            owner: coreConfig.owner,
            beneficiary: coreConfig.owner,
            oracleKey: coreConfig.owner,
            overhead: {},
            oracleConfig: {},
          };
          writeYamlOrJson(config.coreApplyConfigPath, coreConfig);
          await coreCommands.apply(config.privateKey);

          // Read to get hook address
          const firstConfig: DerivedCoreConfig =
            await coreCommands.readConfig();
          const firstHookAddress = firstConfig[hookField].address;

          // Apply same config again
          await coreCommands.apply(config.privateKey);

          // Verify address unchanged
          const secondConfig: DerivedCoreConfig =
            await coreCommands.readConfig();
          expect(secondConfig[hookField].address).to.equal(firstHookAddress);
        });
      });
    });
  });

  describe('Core config idempotency', () => {
    beforeEach(async () => {
      // Deploy fresh core
      const baseCoreConfig: CoreConfig = readYamlOrJson(
        config.baseCoreConfigPath,
      );
      writeYamlOrJson(config.coreApplyConfigPath, baseCoreConfig);
      coreCommands.setCoreInputPath(config.coreApplyConfigPath);
      await coreCommands.deploy(config.privateKey);
    });

    it('should not redeploy when applying same config twice', async function () {
      // Set specific ISM and hooks
      const coreConfig: CoreConfig = readYamlOrJson(config.baseCoreConfigPath);
      coreConfig.defaultIsm = {
        type: IsmType.TEST_ISM,
      };
      coreConfig.defaultHook = {
        type: HookType.MERKLE_TREE,
      };
      coreConfig.requiredHook = {
        type: HookType.MERKLE_TREE,
      };
      writeYamlOrJson(config.coreApplyConfigPath, coreConfig);
      await coreCommands.apply(config.privateKey);

      // Read to get addresses
      const firstConfig: DerivedCoreConfig = await coreCommands.readConfig();
      const firstIsmAddress = firstConfig.defaultIsm.address;
      const firstDefaultHookAddress = firstConfig.defaultHook.address;
      const firstRequiredHookAddress = firstConfig.requiredHook.address;

      // Apply same config again
      await coreCommands.apply(config.privateKey);

      // Read and verify addresses unchanged
      const secondConfig: DerivedCoreConfig = await coreCommands.readConfig();
      expect(secondConfig.defaultIsm.address).to.equal(firstIsmAddress);
      expect(secondConfig.defaultHook.address).to.equal(
        firstDefaultHookAddress,
      );
      expect(secondConfig.requiredHook.address).to.equal(
        firstRequiredHookAddress,
      );
    });
  });
}
