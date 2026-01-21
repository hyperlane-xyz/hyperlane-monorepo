import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ArtifactDeployed,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import {
  DeployedWarpAddress,
  RawCollateralWarpArtifactConfig,
  RawSyntheticWarpArtifactConfig,
  WarpArtifactConfig,
  WarpType,
} from '@hyperlane-xyz/provider-sdk/warp';
import { assert, eqAddressRadix } from '@hyperlane-xyz/utils';

import { RadixSigner } from '../clients/signer.js';
import {
  DEFAULT_E2E_TEST_TIMEOUT,
  TEST_RADIX_BURN_ADDRESS,
  TEST_RADIX_CHAIN_METADATA,
  TEST_RADIX_DEPLOYER_ADDRESS,
  TEST_RADIX_PRIVATE_KEY,
} from '../testing/constants.js';
import { RadixWarpArtifactManager } from '../warp/warp-artifact-manager.js';

import { DEPLOYED_TEST_CHAIN_METADATA } from './e2e-test.setup.js';

chai.use(chaiAsPromised);

describe('Radix Warp Tokens (e2e)', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let radixSigner: RadixSigner;
  let providerSdkSigner: ISigner<AnnotatedTx, TxReceipt>;
  let artifactManager: RadixWarpArtifactManager;

  const DOMAIN_1 = 42;
  const DOMAIN_2 = 96;

  before(async () => {
    const rpcUrls =
      TEST_RADIX_CHAIN_METADATA.rpcUrls?.map((url) => url.http) ?? [];
    assert(rpcUrls.length > 0, 'Expected at least 1 rpc url for the tests');

    radixSigner = (await RadixSigner.connectWithSigner(
      rpcUrls,
      TEST_RADIX_PRIVATE_KEY,
      {
        metadata: {
          chainId: DEPLOYED_TEST_CHAIN_METADATA.chainId,
          gatewayUrls: DEPLOYED_TEST_CHAIN_METADATA.gatewayUrls,
          packageAddress: DEPLOYED_TEST_CHAIN_METADATA.packageAddress,
        },
      },
    )) as RadixSigner;

    providerSdkSigner = radixSigner;

    const gateway = (radixSigner as any).gateway;
    const base = (radixSigner as any).base;
    artifactManager = new RadixWarpArtifactManager(gateway, base);
  });

  // Table-driven tests for both token types
  const tokenTestCases: Array<{
    type: WarpType;
    name: string;
    getConfig: () =>
      | RawCollateralWarpArtifactConfig
      | RawSyntheticWarpArtifactConfig;
    expectedFields?: Record<string, any>;
  }> = [
    {
      type: AltVM.TokenType.collateral,
      name: 'collateral',
      getConfig: () => ({
        type: AltVM.TokenType.collateral,
        owner: TEST_RADIX_DEPLOYER_ADDRESS,
        mailbox: TEST_RADIX_DEPLOYER_ADDRESS,
        token: TEST_RADIX_CHAIN_METADATA.nativeToken.denom,
        remoteRouters: {},
        destinationGas: {},
      }),
      expectedFields: {
        token: TEST_RADIX_CHAIN_METADATA.nativeToken.denom,
      },
    },
    {
      type: AltVM.TokenType.synthetic,
      name: 'synthetic',
      getConfig: () => ({
        type: AltVM.TokenType.synthetic,
        owner: TEST_RADIX_DEPLOYER_ADDRESS,
        mailbox: TEST_RADIX_DEPLOYER_ADDRESS,
        name: 'Test Token',
        symbol: 'TEST',
        decimals: 18,
        remoteRouters: {},
        destinationGas: {},
      }),
      expectedFields: { name: 'Test Token', symbol: 'TEST', decimals: 18 },
    },
  ];

  tokenTestCases.forEach(({ type, name, getConfig, expectedFields }) => {
    describe(`${name} token`, () => {
      it('should create and read token', async () => {
        const config = getConfig();

        const writer = artifactManager.createWriter(type, radixSigner);
        const [result, receipts] = await writer.create({ config });

        expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
        expect(result.config.type).to.equal(type);
        expect(result.deployed.address).to.be.a('string').and.not.be.empty;
        expect(receipts).to.be.an('array').with.length.greaterThan(0);

        // Verify expected fields
        if (expectedFields) {
          for (const [field, expectedValue] of Object.entries(expectedFields)) {
            expect((result.config as any)[field]).to.equal(expectedValue);
          }
        }

        // Read back the token
        const reader = artifactManager.createReader(type);
        const readToken = await reader.read(result.deployed.address);

        expect(readToken.artifactState).to.equal(ArtifactState.DEPLOYED);
        expect(readToken.config.type).to.equal(type);
        expect(readToken.deployed.address).to.equal(result.deployed.address);
      });

      it('should create token with different owner', async () => {
        const config = getConfig();
        config.owner = TEST_RADIX_BURN_ADDRESS;

        const writer = artifactManager.createWriter(type, radixSigner);
        const [deployedToken] = await writer.create({ config });

        const reader = artifactManager.createReader(type);
        const readToken = await reader.read(deployedToken.deployed.address);

        expect(eqAddressRadix(readToken.config.owner, TEST_RADIX_BURN_ADDRESS))
          .to.be.true;
      });

      it('should enroll remote routers', async () => {
        const initialConfig = getConfig();

        const writer = artifactManager.createWriter(type, radixSigner);
        const [deployedToken] = await writer.create({
          config: initialConfig,
        });

        // Update with remote routers
        const updatedConfig: ArtifactDeployed<any, DeployedWarpAddress> = {
          ...deployedToken,
          config: {
            ...deployedToken.config,
            remoteRouters: {
              [DOMAIN_1]: {
                address:
                  '0xc2c6885c3c9e16064d86ce46b7a1ac57888a1e60b2ce88d2504347d3418399c4',
              },
              [DOMAIN_2]: {
                address:
                  '0x1aac830e4d71000c25149af643b5a18c7a907e2d36147d8b57c5847b03ea5528',
              },
            },
            destinationGas: {
              [DOMAIN_1]: '100000',
              [DOMAIN_2]: '200000',
            },
          },
        };

        const txs = await writer.update(updatedConfig);
        expect(txs).to.be.an('array').with.length.greaterThan(0);

        for (const tx of txs) {
          await providerSdkSigner.sendAndConfirmTransaction(tx);
        }

        // Verify
        const reader = artifactManager.createReader(type);
        const readToken = await reader.read(deployedToken.deployed.address);

        expect(readToken.config.remoteRouters[DOMAIN_1].address).to.equal(
          '0xc2c6885c3c9e16064d86ce46b7a1ac57888a1e60b2ce88d2504347d3418399c4',
        );
        expect(readToken.config.remoteRouters[DOMAIN_2].address).to.equal(
          '0x1aac830e4d71000c25149af643b5a18c7a907e2d36147d8b57c5847b03ea5528',
        );
        expect(readToken.config.destinationGas[DOMAIN_1]).to.equal('100000');
        expect(readToken.config.destinationGas[DOMAIN_2]).to.equal('200000');
      });

      it('should unenroll removed routers', async () => {
        const initialConfig = getConfig();
        initialConfig.remoteRouters = {
          [DOMAIN_1]: {
            address:
              '0xc2c6885c3c9e16064d86ce46b7a1ac57888a1e60b2ce88d2504347d3418399c4',
          },
          [DOMAIN_2]: {
            address:
              '0x1aac830e4d71000c25149af643b5a18c7a907e2d36147d8b57c5847b03ea5528',
          },
        };
        initialConfig.destinationGas = {
          [DOMAIN_1]: '100000',
          [DOMAIN_2]: '200000',
        };

        const writer = artifactManager.createWriter(type, radixSigner);
        const [deployedToken] = await writer.create({
          config: initialConfig,
        });

        // Remove DOMAIN_2
        const updatedConfig: ArtifactDeployed<any, DeployedWarpAddress> = {
          ...deployedToken,
          config: {
            ...deployedToken.config,
            remoteRouters: {
              [DOMAIN_1]: {
                address:
                  '0xc2c6885c3c9e16064d86ce46b7a1ac57888a1e60b2ce88d2504347d3418399c4',
              },
            },
            destinationGas: {
              [DOMAIN_1]: '100000',
            },
          },
        };

        const txs = await writer.update(updatedConfig);
        expect(txs).to.be.an('array').with.length.greaterThan(0);

        for (const tx of txs) {
          await providerSdkSigner.sendAndConfirmTransaction(tx);
        }

        // Verify DOMAIN_2 was unenrolled
        const reader = artifactManager.createReader(type);
        const readToken = await reader.read(deployedToken.deployed.address);

        expect(readToken.config.remoteRouters[DOMAIN_1]).to.exist;
        expect(readToken.config.remoteRouters[DOMAIN_2]).to.be.undefined;
      });

      it('should transfer ownership via update (ownership last)', async () => {
        const initialConfig = getConfig();

        const writer = artifactManager.createWriter(type, radixSigner);
        const [deployedToken] = await writer.create({
          config: initialConfig,
        });

        const customIsmAddress = TEST_RADIX_BURN_ADDRESS;

        // Update routers, ISM, AND ownership
        const updatedConfig: ArtifactDeployed<
          WarpArtifactConfig,
          DeployedWarpAddress
        > = {
          ...deployedToken,
          config: {
            ...deployedToken.config,
            owner: TEST_RADIX_BURN_ADDRESS,
            interchainSecurityModule: {
              artifactState: ArtifactState.UNDERIVED,
              deployed: {
                address: customIsmAddress,
              },
            },
            remoteRouters: {
              [DOMAIN_1]: {
                address:
                  '0xc2c6885c3c9e16064d86ce46b7a1ac57888a1e60b2ce88d2504347d3418399c4',
              },
            },
            destinationGas: {
              [DOMAIN_1]: '100000',
            },
          },
        };

        const txs = await writer.update(updatedConfig as any);
        expect(txs).to.be.an('array').with.length.greaterThan(0);

        // Verify ownership transfer is the LAST transaction
        const lastTx = txs[txs.length - 1];
        expect(lastTx.annotation).to.include('owner');

        // Execute all transactions
        for (const tx of txs) {
          await providerSdkSigner.sendAndConfirmTransaction(tx);
        }

        // Verify router enrollment, ISM, AND ownership transfer succeeded
        const reader = artifactManager.createReader(type);
        const readToken = await reader.read(deployedToken.deployed.address);

        expect(readToken.config.remoteRouters[DOMAIN_1].address).to.equal(
          '0xc2c6885c3c9e16064d86ce46b7a1ac57888a1e60b2ce88d2504347d3418399c4',
        );
        expect(
          eqAddressRadix(
            readToken.config.interchainSecurityModule?.deployed.address!,
            customIsmAddress,
          ),
        ).to.be.true;
        expect(eqAddressRadix(readToken.config.owner, TEST_RADIX_BURN_ADDRESS))
          .to.be.true;
      });

      it('should return no update transactions when config is unchanged', async () => {
        const config = getConfig();

        const writer = artifactManager.createWriter(type, radixSigner);
        const [deployedToken] = await writer.create({ config });

        const txs = await writer.update(deployedToken);
        expect(txs).to.be.an('array').with.length(0);
      });
    });
  });

  describe('Generic warp token reading via readWarpToken', () => {
    tokenTestCases.forEach(({ type, name, getConfig }) => {
      it(`should detect and read ${name} token`, async () => {
        const config = getConfig();

        const writer = artifactManager.createWriter(type, radixSigner);
        const [deployedToken] = await writer.create({ config });

        // Read via generic readWarpToken (without knowing the type)
        const readToken = await artifactManager.readWarpToken(
          deployedToken.deployed.address,
        );

        expect(readToken.artifactState).to.equal(ArtifactState.DEPLOYED);
        expect(readToken.config.type).to.equal(type);
        expect(readToken.deployed.address).to.equal(
          deployedToken.deployed.address,
        );
      });
    });
  });
});
