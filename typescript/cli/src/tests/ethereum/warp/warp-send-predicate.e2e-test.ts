import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { JsonRpcProvider } from '@ethersproject/providers';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Wallet } from 'ethers';

import {
  ERC20Test__factory,
  MockPredicateRegistry__factory,
} from '@hyperlane-xyz/core';
import { type ChainAddresses } from '@hyperlane-xyz/registry';
import {
  type ChainMetadata,
  TokenType,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { type Address } from '@hyperlane-xyz/utils';

import { WarpSendLogs } from '../../../send/transfer.js';
import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import {
  hyperlaneWarpDeploy,
  hyperlaneWarpSendRelay,
} from '../commands/warp.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  TEMP_PATH,
  getCombinedWarpRoutePath,
} from '../consts.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

describe('hyperlane warp send with Predicate e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Metadata: ChainMetadata;
  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};

  let ownerAddress: Address;
  let walletChain2: Wallet;
  let providerChain2: JsonRpcProvider;

  let testTokenAddress: Address;
  let mockPredicateRegistryAddress: Address;

  const MOCK_POLICY_ID = 'x-test-policy-predicate-send-e2e';

  before(async function () {
    chain2Metadata = readYamlOrJson(CHAIN_2_METADATA_PATH);

    providerChain2 = new JsonRpcProvider(chain2Metadata.rpcUrls[0].http);
    walletChain2 = new Wallet(ANVIL_KEY).connect(providerChain2);
    ownerAddress = walletChain2.address;

    [chain2Addresses, chain3Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);

    const testToken = await new ERC20Test__factory(walletChain2).deploy(
      'Predicate Send Test Token',
      'PSTEST',
      '1000000000000000000000000',
      18,
    );
    await testToken.deployed();
    testTokenAddress = testToken.address;

    const mockRegistry = await new MockPredicateRegistry__factory(
      walletChain2,
    ).deploy();
    await mockRegistry.deployed();
    mockPredicateRegistryAddress = mockRegistry.address;
  });

  describe('transfer with pre-obtained attestation', () => {
    const warpDeployPath = `${TEMP_PATH}/warp-deploy-predicate-send.yaml`;
    const warpCoreConfigPath = getCombinedWarpRoutePath('PREDSEND', [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);

    before(async function () {
      const warpConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.collateral,
          token: testTokenAddress,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
          predicateWrapper: {
            predicateRegistry: mockPredicateRegistryAddress,
            policyId: MOCK_POLICY_ID,
            owner: ownerAddress,
          },
        },
        [CHAIN_NAME_3]: {
          type: TokenType.synthetic,
          mailbox: chain3Addresses.mailbox,
          owner: ownerAddress,
        },
      };

      writeYamlOrJson(warpDeployPath, warpConfig);
      await hyperlaneWarpDeploy(warpDeployPath, 'PREDSEND/anvil2-anvil3');
    });

    it('should transfer using --attestation flag', async function () {
      const mockAttestation = JSON.stringify({
        uuid: '550e8400-e29b-41d4-a716-446655440000',
        expiration: Math.floor(Date.now() / 1000) + 3600,
        attester: mockPredicateRegistryAddress,
        signature:
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef12',
      });

      const { exitCode, stdout } = await hyperlaneWarpSendRelay({
        origin: CHAIN_NAME_2,
        destination: CHAIN_NAME_3,
        warpRouteId: warpCoreConfigPath,
        value: 1,
        attestation: mockAttestation,
      });

      expect(exitCode).to.equal(0);
      expect(stdout).to.include(WarpSendLogs.SUCCESS);
    });
  });

  describe('transfer with API key (mocked fetch)', () => {
    const warpDeployPath = `${TEMP_PATH}/warp-deploy-predicate-send-api.yaml`;
    const warpCoreConfigPath = getCombinedWarpRoutePath('PREDSENDAPI', [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);

    let mockServer: http.Server;
    let mockServerUrl: string;
    let capturedApiKey: string | undefined;

    before(async function () {
      const warpConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.collateral,
          token: testTokenAddress,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
          predicateWrapper: {
            predicateRegistry: mockPredicateRegistryAddress,
            policyId: MOCK_POLICY_ID,
            owner: ownerAddress,
          },
        },
        [CHAIN_NAME_3]: {
          type: TokenType.synthetic,
          mailbox: chain3Addresses.mailbox,
          owner: ownerAddress,
        },
      };

      writeYamlOrJson(warpDeployPath, warpConfig);
      await hyperlaneWarpDeploy(warpDeployPath, 'PREDSENDAPI/anvil2-anvil3');

      // Start a local mock HTTP server so subprocess fetch calls are intercepted
      mockServer = http.createServer((req, res) => {
        capturedApiKey = req.headers['x-api-key'] as string | undefined;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            policy_id: MOCK_POLICY_ID,
            policy_name: 'Test Policy',
            verification_hash: 'x-test-hash',
            is_compliant: true,
            attestation: {
              uuid: '550e8400-e29b-41d4-a716-446655440001',
              expiration: Math.floor(Date.now() / 1000) + 3600,
              attester: mockPredicateRegistryAddress,
              signature:
                '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef12',
            },
          }),
        );
      });
      await new Promise<void>((resolve) =>
        mockServer.listen(0, '127.0.0.1', resolve),
      );
      const { port } = mockServer.address() as AddressInfo;
      mockServerUrl = `http://127.0.0.1:${port}`;
    });

    after(async function () {
      await new Promise<void>((resolve, reject) =>
        mockServer.close((err) => (err ? reject(err) : resolve())),
      );
    });

    beforeEach(() => {
      capturedApiKey = undefined;
    });

    it('should fetch attestation and transfer using --predicate-api-key flag', async function () {
      const { exitCode, stdout } = await hyperlaneWarpSendRelay({
        origin: CHAIN_NAME_2,
        destination: CHAIN_NAME_3,
        warpRouteId: warpCoreConfigPath,
        value: 1,
        predicateApiKey: 'test-api-key',
        predicateApiUrl: mockServerUrl,
      });

      expect(exitCode).to.equal(0);
      expect(stdout).to.include(WarpSendLogs.SUCCESS);
      expect(capturedApiKey).to.equal('test-api-key');
    });
  });

  describe('native token with predicate wrapper', () => {
    const warpDeployPath = `${TEMP_PATH}/warp-deploy-predicate-native-send.yaml`;
    const warpCoreConfigPath = getCombinedWarpRoutePath('PREDNATIVESEND', [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);

    before(async function () {
      const warpConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.native,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
          predicateWrapper: {
            predicateRegistry: mockPredicateRegistryAddress,
            policyId: MOCK_POLICY_ID,
            owner: ownerAddress,
          },
        },
        [CHAIN_NAME_3]: {
          type: TokenType.synthetic,
          mailbox: chain3Addresses.mailbox,
          owner: ownerAddress,
        },
      };

      writeYamlOrJson(warpDeployPath, warpConfig);
      await hyperlaneWarpDeploy(warpDeployPath, 'PREDNATIVESEND/anvil2-anvil3');
    });

    it('should transfer native token using --attestation flag', async function () {
      const mockAttestation = JSON.stringify({
        uuid: '550e8400-e29b-41d4-a716-446655440002',
        expiration: Math.floor(Date.now() / 1000) + 3600,
        attester: mockPredicateRegistryAddress,
        signature:
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef12',
      });

      const { exitCode, stdout } = await hyperlaneWarpSendRelay({
        origin: CHAIN_NAME_2,
        destination: CHAIN_NAME_3,
        warpRouteId: warpCoreConfigPath,
        value: 1,
        attestation: mockAttestation,
      });

      expect(exitCode).to.equal(0);
      expect(stdout).to.include(WarpSendLogs.SUCCESS);
    });
  });

  describe('native token without predicate wrapper should fail', () => {
    const warpDeployPath = `${TEMP_PATH}/warp-deploy-native-send.yaml`;
    const warpCoreConfigPath = getCombinedWarpRoutePath('NATIVESEND', [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);

    before(async function () {
      const warpConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.native,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
        },
        [CHAIN_NAME_3]: {
          type: TokenType.synthetic,
          mailbox: chain3Addresses.mailbox,
          owner: ownerAddress,
        },
      };

      writeYamlOrJson(warpDeployPath, warpConfig);
      await hyperlaneWarpDeploy(warpDeployPath, 'NATIVESEND/anvil2-anvil3');
    });

    it('should fail when attestation is used without a configured wrapper', async function () {
      const mockAttestation = JSON.stringify({
        uuid: '550e8400-e29b-41d4-a716-446655440000',
        expiration: Math.floor(Date.now() / 1000) + 3600,
        attester: mockPredicateRegistryAddress,
        signature: '0x1234',
      });

      const { exitCode, stderr } = await hyperlaneWarpSendRelay({
        origin: CHAIN_NAME_2,
        destination: CHAIN_NAME_3,
        warpRouteId: warpCoreConfigPath,
        value: 1,
        attestation: mockAttestation,
      }).nothrow();

      expect(exitCode).to.not.equal(0);
      expect(stderr).to.include('PredicateRouterWrapper');
    });
  });

  describe('attestation without predicate wrapper should fail', () => {
    const warpDeployPath = `${TEMP_PATH}/warp-deploy-no-predicate.yaml`;
    const warpCoreConfigPath = getCombinedWarpRoutePath('NOPRED', [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);

    before(async function () {
      const warpConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.collateral,
          token: testTokenAddress,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
        },
        [CHAIN_NAME_3]: {
          type: TokenType.synthetic,
          mailbox: chain3Addresses.mailbox,
          owner: ownerAddress,
        },
      };

      writeYamlOrJson(warpDeployPath, warpConfig);
      await hyperlaneWarpDeploy(warpDeployPath, 'NOPRED/anvil2-anvil3');
    });

    it('should fail when route has no PredicateRouterWrapper', async function () {
      const mockAttestation = JSON.stringify({
        uuid: '550e8400-e29b-41d4-a716-446655440000',
        expiration: Math.floor(Date.now() / 1000) + 3600,
        attester: mockPredicateRegistryAddress,
        signature: '0x1234',
      });

      const { exitCode, stderr } = await hyperlaneWarpSendRelay({
        origin: CHAIN_NAME_2,
        destination: CHAIN_NAME_3,
        warpRouteId: warpCoreConfigPath,
        value: 1,
        attestation: mockAttestation,
      }).nothrow();

      expect(exitCode).to.not.equal(0);
      expect(stderr).to.include('PredicateRouterWrapper');
    });
  });
});
