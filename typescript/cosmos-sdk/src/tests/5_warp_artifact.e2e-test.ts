import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { type ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import {
  type DeployedWarpAddress,
  type RawCollateralWarpArtifactConfig,
  type RawSyntheticWarpArtifactConfig,
  type WarpArtifactConfig,
  type WarpType,
} from '@hyperlane-xyz/provider-sdk/warp';
import { assert, eqAddressCosmos } from '@hyperlane-xyz/utils';

import { type CosmosNativeSigner } from '../clients/signer.js';
import { DEFAULT_E2E_TEST_TIMEOUT } from '../testing/constants.js';
import { createSigner } from '../testing/utils.js';
import { CosmosWarpArtifactManager } from '../warp/warp-artifact-manager.js';

chai.use(chaiAsPromised);

describe('Cosmos Warp Artifacts (e2e)', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let cosmosSigner: CosmosNativeSigner;
  let providerSdkSigner: ISigner<AnnotatedTx, TxReceipt>;
  let artifactManager: CosmosWarpArtifactManager;
  let mailboxAddress: string;
  let deployerAddress: string;
  let newOwnerAddress: string;
  let testIsmAddress: string;
  let secondIsmAddress: string;

  const DOMAIN_1 = 42;
  const DOMAIN_2 = 96;

  before(async () => {
    cosmosSigner = (await createSigner('alice')) as CosmosNativeSigner;
    providerSdkSigner = cosmosSigner;
    deployerAddress = cosmosSigner.getSignerAddress();

    // Create new owner address (using bob signer)
    const bobSigner = await createSigner('bob');
    newOwnerAddress = bobSigner.getSignerAddress();

    const rpcUrls = cosmosSigner.getRpcUrls();
    assert(rpcUrls.length > 0, 'Expected at least 1 rpc url for the tests');

    artifactManager = new CosmosWarpArtifactManager(rpcUrls);

    // Create ISM addresses for tests
    const ism1 = await cosmosSigner.createNoopIsm({});
    testIsmAddress = ism1.ismAddress;

    const ism2 = await cosmosSigner.createNoopIsm({});
    secondIsmAddress = ism2.ismAddress;

    // Set up mailbox for tests
    const mailboxResponse = await cosmosSigner.createMailbox({
      domainId: 1234,
      defaultIsmAddress: testIsmAddress,
    });
    mailboxAddress = mailboxResponse.mailboxAddress;
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
        owner: deployerAddress,
        mailbox: mailboxAddress,
        token: 'uhyp',
        name: '',
        symbol: '',
        decimals: 0,
        remoteRouters: {},
        destinationGas: {},
      }),
      expectedFields: {
        token: 'uhyp',
        name: '',
        symbol: '',
        decimals: 0,
      },
    },
    {
      type: AltVM.TokenType.synthetic,
      name: 'synthetic',
      getConfig: () => ({
        type: AltVM.TokenType.synthetic,
        owner: deployerAddress,
        mailbox: mailboxAddress,
        name: '',
        symbol: '',
        decimals: 0,
        remoteRouters: {},
        destinationGas: {},
      }),
      expectedFields: {
        name: '',
        symbol: '',
        decimals: 0,
      },
    },
  ];

  tokenTestCases.forEach(({ type, name, getConfig, expectedFields }) => {
    describe(`${name} token`, () => {
      it('should create and read token', async () => {
        const config = getConfig();

        const writer = artifactManager.createWriter(type, cosmosSigner);
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

      it('should enroll remote routers', async () => {
        const initialConfig = getConfig();

        const writer = artifactManager.createWriter(type, cosmosSigner);
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

        const writer = artifactManager.createWriter(type, cosmosSigner);
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

      it('should update when only destination gas changes', async () => {
        const initialConfig = getConfig();
        const routerAddress =
          '0xc2c6885c3c9e16064d86ce46b7a1ac57888a1e60b2ce88d2504347d3418399c4';

        // Create with initial gas value
        initialConfig.remoteRouters = {
          [DOMAIN_1]: { address: routerAddress },
        };
        initialConfig.destinationGas = {
          [DOMAIN_1]: '100000',
        };

        const writer = artifactManager.createWriter(type, cosmosSigner);
        const [deployedToken] = await writer.create({
          config: initialConfig,
        });

        // Verify initial gas value
        const reader = artifactManager.createReader(type);
        const readToken1 = await reader.read(deployedToken.deployed.address);
        expect(readToken1.config.destinationGas[DOMAIN_1]).to.equal('100000');

        // Update only gas (router address unchanged)
        const updatedConfig: ArtifactDeployed<any, DeployedWarpAddress> = {
          ...deployedToken,
          config: {
            ...deployedToken.config,
            remoteRouters: {
              [DOMAIN_1]: { address: routerAddress }, // Same address
            },
            destinationGas: {
              [DOMAIN_1]: '200000', // Changed gas
            },
          },
        };

        const txs = await writer.update(updatedConfig);
        expect(txs).to.be.an('array').with.length.greaterThan(0);

        // Execute update
        for (const tx of txs) {
          await providerSdkSigner.sendAndConfirmTransaction(tx);
        }

        // Verify gas changed
        const readToken2 = await reader.read(deployedToken.deployed.address);
        expect(readToken2.config.destinationGas[DOMAIN_1]).to.equal('200000');
        expect(
          eqAddressCosmos(
            readToken2.config.remoteRouters[DOMAIN_1].address,
            routerAddress,
          ),
        ).to.be.true;
      });

      it('should transfer ownership via update (ownership last)', async () => {
        const initialConfig = getConfig();

        const writer = artifactManager.createWriter(type, cosmosSigner);
        const [deployedToken] = await writer.create({
          config: initialConfig,
        });

        const customIsmAddress = testIsmAddress;

        // Update routers, ISM, AND ownership
        const updatedConfig: ArtifactDeployed<
          WarpArtifactConfig,
          DeployedWarpAddress
        > = {
          ...deployedToken,
          config: {
            ...deployedToken.config,
            owner: newOwnerAddress,
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
        assert(
          readToken.config.interchainSecurityModule?.deployed.address,
          'ISM address should be set',
        );
        expect(
          eqAddressCosmos(
            readToken.config.interchainSecurityModule.deployed.address,
            customIsmAddress,
          ),
        ).to.be.true;
        expect(eqAddressCosmos(readToken.config.owner, newOwnerAddress)).to.be
          .true;
      });

      it('should return no update transactions when config is unchanged', async () => {
        const config = getConfig();

        const writer = artifactManager.createWriter(type, cosmosSigner);
        const [deployedToken] = await writer.create({ config });

        const txs = await writer.update(deployedToken);
        expect(txs).to.be.an('array').with.length(0);
      });

      describe('ISM updates', function () {
        // Note: Cosmos does not support unsetting ISM (changing from address to undefined)
        // because the underlying chain code doesn't support it yet

        it('should set ISM when changed from undefined to address', async () => {
          const initialConfig = getConfig();
          // Start with no ISM
          initialConfig.interchainSecurityModule = undefined;

          const writer = artifactManager.createWriter(type, cosmosSigner);
          const [deployedToken] = await writer.create({
            config: initialConfig,
          });

          // Verify ISM is unset
          const reader = artifactManager.createReader(type);
          const readToken1 = await reader.read(deployedToken.deployed.address);
          expect(readToken1.config.interchainSecurityModule).to.be.undefined;

          // Update to set ISM
          const customIsmAddress = testIsmAddress;
          const updatedConfig: ArtifactDeployed<any, DeployedWarpAddress> = {
            ...deployedToken,
            config: {
              ...deployedToken.config,
              interchainSecurityModule: {
                artifactState: ArtifactState.UNDERIVED,
                deployed: {
                  address: customIsmAddress,
                },
              },
            },
          };

          const txs = await writer.update(updatedConfig);
          expect(txs).to.be.an('array').with.length.greaterThan(0);

          // Execute update
          for (const tx of txs) {
            await providerSdkSigner.sendAndConfirmTransaction(tx);
          }

          // Verify ISM is now set
          const readToken2 = await reader.read(deployedToken.deployed.address);
          assert(
            readToken2.config.interchainSecurityModule?.deployed.address,
            'ISM address should be set',
          );
          expect(
            eqAddressCosmos(
              readToken2.config.interchainSecurityModule.deployed.address,
              customIsmAddress,
            ),
          ).to.be.true;
        });

        it('should change ISM when updated to different address', async () => {
          const initialConfig = getConfig();
          const firstIsmAddress = testIsmAddress;

          // Create with first ISM
          initialConfig.interchainSecurityModule = {
            artifactState: ArtifactState.UNDERIVED,
            deployed: {
              address: firstIsmAddress,
            },
          };

          const writer = artifactManager.createWriter(type, cosmosSigner);
          const [deployedToken] = await writer.create({
            config: initialConfig,
          });

          // Verify first ISM is set
          const reader = artifactManager.createReader(type);
          const readToken1 = await reader.read(deployedToken.deployed.address);
          assert(
            readToken1.config.interchainSecurityModule?.deployed.address,
            'ISM address should be set',
          );
          expect(
            eqAddressCosmos(
              readToken1.config.interchainSecurityModule.deployed.address,
              firstIsmAddress,
            ),
          ).to.be.true;

          // Update to second ISM
          const updatedConfig: ArtifactDeployed<any, DeployedWarpAddress> = {
            ...deployedToken,
            config: {
              ...deployedToken.config,
              interchainSecurityModule: {
                artifactState: ArtifactState.UNDERIVED,
                deployed: {
                  address: secondIsmAddress,
                },
              },
            },
          };

          const txs = await writer.update(updatedConfig);
          expect(txs).to.be.an('array').with.length.greaterThan(0);

          // Execute update
          for (const tx of txs) {
            await providerSdkSigner.sendAndConfirmTransaction(tx);
          }

          // Verify ISM changed to second address
          const readToken2 = await reader.read(deployedToken.deployed.address);
          assert(
            readToken2.config.interchainSecurityModule?.deployed.address,
            'ISM address should be set',
          );
          expect(
            eqAddressCosmos(
              readToken2.config.interchainSecurityModule.deployed.address,
              secondIsmAddress,
            ),
          ).to.be.true;
        });

        it('should not generate ISM update tx when ISM unchanged', async () => {
          const initialConfig = getConfig();
          const customIsmAddress = testIsmAddress;

          // Create with ISM
          initialConfig.interchainSecurityModule = {
            artifactState: ArtifactState.UNDERIVED,
            deployed: {
              address: customIsmAddress,
            },
          };

          const writer = artifactManager.createWriter(type, cosmosSigner);
          const [deployedToken] = await writer.create({
            config: initialConfig,
          });

          // Update with same ISM (no change)
          const txs = await writer.update(deployedToken);

          // Should have no transactions (ISM unchanged)
          expect(txs).to.be.an('array').with.length(0);
        });

        it('should not generate ISM update tx when both undefined', async () => {
          const initialConfig = getConfig();
          // Create without ISM
          initialConfig.interchainSecurityModule = undefined;

          const writer = artifactManager.createWriter(type, cosmosSigner);
          const [deployedToken] = await writer.create({
            config: initialConfig,
          });

          // Update with ISM still undefined (no change)
          const txs = await writer.update(deployedToken);

          // Should have no transactions (ISM still undefined)
          expect(txs).to.be.an('array').with.length(0);
        });
      });
    });
  });

  describe('Generic warp token reading via readWarpToken', () => {
    tokenTestCases.forEach(({ type, name, getConfig }) => {
      it(`should detect and read ${name} token`, async () => {
        const config = getConfig();

        const writer = artifactManager.createWriter(type, cosmosSigner);
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
