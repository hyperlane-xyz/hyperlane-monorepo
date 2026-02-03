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
  RawWarpArtifactConfig,
  WarpArtifactConfig,
  WarpType,
} from '@hyperlane-xyz/provider-sdk/warp';
import { assert, eqAddressRadix } from '@hyperlane-xyz/utils';

import { RadixSigner } from '../clients/signer.js';
import {
  DEFAULT_E2E_TEST_TIMEOUT,
  OTHER_RADIX_PRIVATE_KEY,
  TEST_RADIX_BURN_ADDRESS,
  TEST_RADIX_CHAIN_METADATA,
  TEST_RADIX_DEPLOYER_ADDRESS,
  TEST_RADIX_PRIVATE_KEY,
} from '../testing/constants.js';
import { transactionManifestToString } from '../utils/utils.js';
import { RadixWarpArtifactManager } from '../warp/warp-artifact-manager.js';

import { DEPLOYED_TEST_CHAIN_METADATA } from './e2e-test.setup.js';

chai.use(chaiAsPromised);

describe('Radix Warp Tokens (e2e)', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let radixSigner: RadixSigner;
  let otherRadixSigner: RadixSigner;
  let providerSdkSigner: ISigner<AnnotatedTx, TxReceipt>;
  let otherProviderSdkSigner: ISigner<AnnotatedTx, TxReceipt>;
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

    otherRadixSigner = (await RadixSigner.connectWithSigner(
      rpcUrls,
      OTHER_RADIX_PRIVATE_KEY,
      {
        metadata: {
          chainId: DEPLOYED_TEST_CHAIN_METADATA.chainId,
          gatewayUrls: DEPLOYED_TEST_CHAIN_METADATA.gatewayUrls,
          packageAddress: DEPLOYED_TEST_CHAIN_METADATA.packageAddress,
        },
      },
    )) as RadixSigner;

    await otherRadixSigner['signer'].getTestnetXrd();

    providerSdkSigner = radixSigner;
    otherProviderSdkSigner = otherRadixSigner;

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

        const writer = artifactManager.createWriter(type, radixSigner);
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
          eqAddressRadix(
            readToken2.config.remoteRouters[DOMAIN_1].address,
            routerAddress,
          ),
        ).to.be.true;
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

        const currentIsmAddress =
          readToken.config.interchainSecurityModule?.deployed.address;
        assert(currentIsmAddress, 'Expected current ism address to be set');
        expect(eqAddressRadix(currentIsmAddress, customIsmAddress)).to.be.true;
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

      describe('Ism updates', function () {
        it('should unset ISM when changed from address to undefined', async () => {
          const initialConfig = getConfig();
          const customIsmAddress = TEST_RADIX_BURN_ADDRESS;

          // Create with ISM set
          initialConfig.interchainSecurityModule = {
            artifactState: ArtifactState.UNDERIVED,
            deployed: {
              address: customIsmAddress,
            },
          };

          const writer = artifactManager.createWriter(type, radixSigner);
          const [deployedToken] = await writer.create({
            config: initialConfig,
          });

          // Verify ISM is set
          const reader = artifactManager.createReader(type);
          const readToken1 = await reader.read(deployedToken.deployed.address);

          const currentIsmAddress =
            readToken1.config.interchainSecurityModule?.deployed.address;
          assert(currentIsmAddress, 'Expected current ism address to be set');
          expect(eqAddressRadix(currentIsmAddress, customIsmAddress)).to.be
            .true;

          // Update to clear ISM (set to undefined)
          const updatedConfig: ArtifactDeployed<any, DeployedWarpAddress> = {
            ...deployedToken,
            config: {
              ...deployedToken.config,
              interchainSecurityModule: undefined,
            },
          };

          const txs = await writer.update(updatedConfig);
          expect(txs).to.be.an('array').with.length.greaterThan(0);

          // Execute update
          for (const tx of txs) {
            await providerSdkSigner.sendAndConfirmTransaction(tx);
          }

          // Verify ISM is now unset
          const readToken2 = await reader.read(deployedToken.deployed.address);
          expect(readToken2.config.interchainSecurityModule).to.be.undefined;
        });

        it('should set ISM when changed from undefined to address', async () => {
          const initialConfig = getConfig();
          // Start with no ISM
          initialConfig.interchainSecurityModule = undefined;

          const writer = artifactManager.createWriter(type, radixSigner);
          const [deployedToken] = await writer.create({
            config: initialConfig,
          });

          // Verify ISM is unset
          const reader = artifactManager.createReader(type);
          const readToken1 = await reader.read(deployedToken.deployed.address);
          expect(readToken1.config.interchainSecurityModule).to.be.undefined;

          // Update to set ISM
          const customIsmAddress = TEST_RADIX_BURN_ADDRESS;
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

          const currentIsmAddress =
            readToken2.config.interchainSecurityModule?.deployed.address;
          assert(currentIsmAddress, 'Expected current ism address to be set');
          expect(eqAddressRadix(currentIsmAddress, customIsmAddress)).to.be
            .true;
        });

        it('should change ISM when updated to different address', async () => {
          const initialConfig = getConfig();
          const firstIsmAddress = TEST_RADIX_BURN_ADDRESS;

          // Create with first ISM
          initialConfig.interchainSecurityModule = {
            artifactState: ArtifactState.UNDERIVED,
            deployed: {
              address: firstIsmAddress,
            },
          };

          const writer = artifactManager.createWriter(type, radixSigner);
          const [deployedToken] = await writer.create({
            config: initialConfig,
          });

          // Verify first ISM is set
          const reader = artifactManager.createReader(type);
          const readToken1 = await reader.read(deployedToken.deployed.address);

          const currentIsmAddress =
            readToken1.config.interchainSecurityModule?.deployed.address;
          assert(currentIsmAddress, 'Expected current ism address to be set');
          expect(eqAddressRadix(currentIsmAddress, firstIsmAddress)).to.be.true;

          // Update to second ISM
          const secondIsmAddress = TEST_RADIX_DEPLOYER_ADDRESS;
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

          const currentIsmAddress2 =
            readToken2.config.interchainSecurityModule?.deployed.address;
          assert(currentIsmAddress2, 'Expected current ism address to be set');
          expect(eqAddressRadix(currentIsmAddress2, secondIsmAddress)).to.be
            .true;
        });

        it('should not generate ISM update tx when ISM unchanged', async () => {
          const initialConfig = getConfig();
          const customIsmAddress = TEST_RADIX_BURN_ADDRESS;

          // Create with ISM
          initialConfig.interchainSecurityModule = {
            artifactState: ArtifactState.UNDERIVED,
            deployed: {
              address: customIsmAddress,
            },
          };

          const writer = artifactManager.createWriter(type, radixSigner);
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

          const writer = artifactManager.createWriter(type, radixSigner);
          const [deployedToken] = await writer.create({
            config: initialConfig,
          });

          // Update with ISM still undefined (no change)
          const txs = await writer.update(deployedToken);

          // Should have no transactions (ISM still undefined)
          expect(txs).to.be.an('array').with.length(0);
        });

        it('should unset ISM when changed to zero address', async () => {
          const initialConfig = getConfig();
          const customIsmAddress = TEST_RADIX_BURN_ADDRESS;

          // Create with ISM set
          initialConfig.interchainSecurityModule = {
            artifactState: ArtifactState.UNDERIVED,
            deployed: {
              address: customIsmAddress,
            },
          };

          const writer = artifactManager.createWriter(type, radixSigner);
          const [deployedToken] = await writer.create({
            config: initialConfig,
          });

          // Verify ISM is set
          const reader = artifactManager.createReader(type);
          const readToken1 = await reader.read(deployedToken.deployed.address);

          const currentIsmAddress =
            readToken1.config.interchainSecurityModule?.deployed.address;
          assert(currentIsmAddress, 'Expected current ism address to be set');
          expect(eqAddressRadix(currentIsmAddress, customIsmAddress)).to.be
            .true;

          // Update to zero address (should unset ISM)
          const zeroAddress = '0000000000000000000000000000000000000000';
          const updatedConfig: ArtifactDeployed<any, DeployedWarpAddress> = {
            ...deployedToken,
            config: {
              ...deployedToken.config,
              interchainSecurityModule: {
                artifactState: ArtifactState.UNDERIVED,
                deployed: {
                  address: zeroAddress,
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

          // Verify ISM is now unset (zero address treated as unset)
          const readToken2 = await reader.read(deployedToken.deployed.address);
          expect(readToken2.config.interchainSecurityModule).to.be.undefined;
        });
      });

      it('should encode all update transactions with current owner as sender after ownership transfer', async () => {
        const initialConfig = getConfig();

        // Create with initial state
        initialConfig.remoteRouters = {
          [DOMAIN_1]: {
            address:
              '0xc2c6885c3c9e16064d86ce46b7a1ac57888a1e60b2ce88d2504347d3418399c4',
          },
        };
        initialConfig.destinationGas = {
          [DOMAIN_1]: '100000',
        };

        const writer = artifactManager.createWriter(type, radixSigner);
        const [deployedToken] = await writer.create({
          config: initialConfig,
        });

        const signerAddress = radixSigner.getSignerAddress();

        // Transfer ownership to a different address first
        const newOwnerAddress = otherRadixSigner.getSignerAddress();

        const ownershipTransferConfig: ArtifactDeployed<
          RawWarpArtifactConfig,
          DeployedWarpAddress
        > = {
          ...deployedToken,
          config: {
            ...deployedToken.config,
            owner: newOwnerAddress,
          },
        };

        const ownershipTxs = await writer.update(ownershipTransferConfig);
        for (const tx of ownershipTxs) {
          await providerSdkSigner.sendAndConfirmTransaction(tx);
        }

        // Read token to verify ownership transfer
        const tokenAfterOwnershipTransfer = await writer.read(
          deployedToken.deployed.address,
        );
        expect(
          eqAddressRadix(
            tokenAfterOwnershipTransfer.config.owner,
            newOwnerAddress,
          ),
        ).to.be.true;

        // Perform multiple updates
        const newIsmAddress = otherRadixSigner.getSignerAddress();
        const updatedConfig: ArtifactDeployed<any, DeployedWarpAddress> = {
          ...tokenAfterOwnershipTransfer,
          deployed: deployedToken.deployed,
          config: {
            ...tokenAfterOwnershipTransfer.config,
            interchainSecurityModule: {
              artifactState: ArtifactState.UNDERIVED,
              deployed: {
                address: newIsmAddress,
              },
            },
            remoteRouters: {
              // Remove DOMAIN_1, add DOMAIN_2
              [DOMAIN_2]: {
                address:
                  '0x1aac830e4d71000c25149af643b5a18c7a907e2d36147d8b57c5847b03ea5528',
              },
            },
            destinationGas: {
              [DOMAIN_2]: '200000',
            },
          },
        };

        const updateTxs = await writer.update(updatedConfig);
        expect(updateTxs).to.be.an('array').with.length.greaterThan(0);

        // Validate ALL update transactions are encoded for the CURRENT owner (not signer)
        const base = (radixSigner as any).base;
        const networkId = base.getNetworkId();

        for (const tx of updateTxs) {
          const manifestString = await transactionManifestToString(
            tx.manifest,
            networkId,
          );

          // Transaction must be encoded for current owner (firstNewOwner), not signer
          expect(manifestString).to.include(
            newOwnerAddress,
            `Transaction "${tx.annotation}" must be encoded for current owner ${newOwnerAddress}, not signer ${signerAddress}`,
          );

          expect(manifestString).not.to.include(
            radixSigner.getSignerAddress(),
            `Transaction "${tx.annotation}" should not include any reference to the original deployer`,
          );

          // Execute transaction
          await otherProviderSdkSigner.sendAndConfirmTransaction(tx);
        }

        // Verify all updates succeeded
        const finalToken = await writer.read(deployedToken.deployed.address);

        const currentIsmAddress =
          finalToken.config.interchainSecurityModule?.deployed.address;
        assert(currentIsmAddress, 'Expected current ism address to be set');
        expect(eqAddressRadix(currentIsmAddress, newIsmAddress)).to.be.true;
        expect(finalToken.config.remoteRouters[DOMAIN_1]).to.be.undefined;
        expect(finalToken.config.remoteRouters[DOMAIN_2]).to.exist;
        expect(finalToken.config.destinationGas[DOMAIN_2]).to.equal('200000');
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
