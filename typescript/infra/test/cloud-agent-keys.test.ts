import { expect } from 'chai';

import { Contexts } from '../config/contexts.js';
import { parseKeyIdentifier } from '../src/agents/agent.js';
import { AgentAwsKey } from '../src/agents/aws/key.js';
import { AgentGCPKey } from '../src/agents/gcp.js';
import { ReadOnlyCloudAgentKey } from '../src/agents/keys.js';
import type { AgentContextConfig } from '../src/config/agent/agent.js';
import { Role } from '../src/roles.js';

describe('ReadOnlyCloudAgentKey', () => {
  describe('fromSerializedAddress', () => {
    it('correctly parses identifiers', () => {
      const addressZero = '0x0000000000000000000000000000000000000000';
      const environment = 'test';
      const context = Contexts.Hyperlane;
      const chainName = 'test1';
      // Enough to satisfy the constructor of AgentAwsKey
      const mockAgentConfig: AgentContextConfig = {
        aws: {
          region: 'us-east-1',
        },
        runEnv: environment,
        namespace: 'test',
        context,
        rolesWithKeys: [],
        contextChainNames: {
          [Role.Validator]: [],
          [Role.Relayer]: [],
          [Role.Scraper]: [],
        },
        environmentChainNames: [],
      };

      // AWS and GCP agent keys to get the identifiers from
      // and ensure they can be correctly parsed
      const testKeys = [
        new AgentGCPKey(environment, context, Role.Deployer),
        new AgentGCPKey(environment, context, Role.Relayer),
        new AgentGCPKey(environment, context, Role.Validator, chainName, 0),
        new AgentAwsKey(mockAgentConfig, Role.Deployer),
        new AgentAwsKey(mockAgentConfig, Role.Relayer),
        new AgentAwsKey(mockAgentConfig, Role.Validator, chainName, 0),
      ];

      for (const testKey of testKeys) {
        const identifier = testKey.identifier;

        const readOnly = ReadOnlyCloudAgentKey.fromSerializedAddress(
          identifier,
          addressZero,
        );

        expect(readOnly.environment).to.eq(testKey.environment);
        expect(readOnly.context).to.eq(testKey.context);
        expect(readOnly.role).to.eq(testKey.role);
        expect(readOnly.chainName).to.eq(testKey.chainName);
        expect(readOnly.index).to.eq(testKey.index);
      }
    });

    it('parses a non-fastpath chain named validator as a chain-scoped validator key', () => {
      const parsed = parseKeyIdentifier(
        'hyperlane-mainnet3-key-validator-validator-0',
      );

      expect(parsed.environment).to.eq('mainnet3');
      expect(parsed.context).to.eq(Contexts.Hyperlane);
      expect(parsed.role).to.eq(Role.Validator);
      expect(parsed.chainName).to.eq('validator');
      expect(parsed.index).to.eq(0);
    });

    it('uses context-level validator key identifiers for fastpath validators', () => {
      const addressZero = '0x0000000000000000000000000000000000000000';
      const environment = 'mainnet3';
      const chainName = 'ethereum';
      const mockAgentConfig: AgentContextConfig = {
        aws: {
          region: 'us-east-1',
        },
        runEnv: environment,
        namespace: 'mainnet3',
        context: Contexts.FastPath,
        rolesWithKeys: [],
        contextChainNames: {
          [Role.Validator]: [],
          [Role.Relayer]: [],
          [Role.Scraper]: [],
        },
        environmentChainNames: [],
      };

      const testKeys = [
        new AgentGCPKey(
          environment,
          Contexts.FastPath,
          Role.Validator,
          chainName,
          0,
        ),
        new AgentAwsKey(mockAgentConfig, Role.Validator, chainName, 0),
      ];

      for (const testKey of testKeys) {
        expect(testKey.identifier).to.not.include(chainName);
        expect(testKey.identifier).to.include(
          `${Contexts.FastPath}-${environment}-key-${Role.Validator}-0`,
        );

        const readOnly = ReadOnlyCloudAgentKey.fromSerializedAddress(
          testKey.identifier,
          addressZero,
        );

        expect(readOnly.environment).to.eq(testKey.environment);
        expect(readOnly.context).to.eq(testKey.context);
        expect(readOnly.role).to.eq(testKey.role);
        expect(readOnly.chainName).to.eq(undefined);
        expect(readOnly.index).to.eq(testKey.index);
      }
    });
  });
});
