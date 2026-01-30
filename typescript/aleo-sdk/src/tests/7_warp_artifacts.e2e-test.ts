import {
  Account,
  AleoKeyProvider,
  NetworkRecordProvider,
  ProgramManager,
} from '@provablehq/sdk';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import type { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  AnnotatedTx,
  TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import type {
  DeployedWarpAddress,
  RawCollateralWarpArtifactConfig,
  RawNativeWarpArtifactConfig,
  RawSyntheticWarpArtifactConfig,
  WarpArtifactConfig,
  WarpType,
} from '@hyperlane-xyz/provider-sdk/warp';
import { assert, eqAddressAleo, rootLogger } from '@hyperlane-xyz/utils';

import { token_registry } from '../artifacts.js';
import { AleoSigner } from '../clients/signer.js';
import {
  TEST_ALEO_BURN_ADDRESS,
  TEST_ALEO_CHAIN_METADATA,
  TEST_ALEO_PRIVATE_KEY,
} from '../testing/constants.js';
import {
  fromAleoAddress,
  getProgramSuffix,
  stringToU128,
} from '../utils/helper.js';
import { AleoWarpArtifactManager } from '../warp/warp-artifact-manager.js';

chai.use(chaiAsPromised);

describe('Aleo Warp Tokens Artifact API (e2e)', function () {
  this.timeout(300_000); // Aleo transactions can be slow

  let aleoSigner: AleoSigner;
  let providerSdkSigner: ISigner<AnnotatedTx, TxReceipt>;
  let artifactManager: AleoWarpArtifactManager;
  let ismManagerProgramId: string;
  let hookManagerProgramId: string;
  let mailboxAddress: string;

  const DOMAIN_1 = 42;
  const DOMAIN_2 = 96;

  before(async () => {
    // Unset ALEO_WARP_SUFFIX to ensure random suffixes for each token
    delete process.env['ALEO_WARP_SUFFIX'];

    aleoSigner = (await AleoSigner.connectWithSigner(
      [TEST_ALEO_CHAIN_METADATA.rpcUrl],
      TEST_ALEO_PRIVATE_KEY,
      {
        metadata: {
          chainId: 1,
        },
      },
    )) as AleoSigner;

    providerSdkSigner = aleoSigner;

    // Deploy ISM manager
    ismManagerProgramId = await aleoSigner.getIsmManager();

    // Deploy mailbox
    const mailbox = await aleoSigner.createMailbox({
      domainId: 1234,
    });
    mailboxAddress = mailbox.mailboxAddress;

    const { programId } = fromAleoAddress(mailboxAddress);
    const suffix = getProgramSuffix(programId);

    hookManagerProgramId = await aleoSigner.getHookManager(suffix);

    // Access the aleoClient from the signer to create the artifact manager
    const aleoClient = (aleoSigner as any).aleoClient;
    artifactManager = new AleoWarpArtifactManager(aleoClient, {
      ismManagerAddress: ismManagerProgramId,
      hookManagerAddress: hookManagerProgramId,
    });

    // Deploy token_registry for collateral tests
    const aleoAccount = new Account({
      privateKey: TEST_ALEO_PRIVATE_KEY,
    });

    const keyProvider = new AleoKeyProvider();
    keyProvider.useCache(true);

    const networkRecordProvider = new NetworkRecordProvider(
      aleoAccount,
      aleoClient,
    );

    const programManager = new ProgramManager(
      TEST_ALEO_CHAIN_METADATA.rpcUrl,
      keyProvider,
      networkRecordProvider,
    );
    programManager.setAccount(aleoAccount);

    try {
      const tx = await programManager.buildDevnodeDeploymentTransaction({
        program: token_registry,
        priorityFee: 0,
        privateFee: false,
      });
      const txId = await programManager.networkClient.submitTransaction(tx);
      await aleoClient.waitForTransactionConfirmation(txId);
    } catch (e) {
      rootLogger.warn(
        'Token registry deployment skipped:',
        (e as Error).message,
      );
    }

    // Register test token for collateral tests
    const collateralDenom = '1field';
    await aleoSigner.sendAndConfirmTransaction({
      programName: 'token_registry.aleo',
      functionName: 'register_token',
      priorityFee: 0,
      privateFee: false,
      inputs: [
        collateralDenom,
        `${stringToU128('Test Token').toString()}u128`,
        `${stringToU128('TEST').toString()}u128`,
        `6u8`,
        `100000000u128`,
        `false`,
        TEST_ALEO_BURN_ADDRESS,
      ],
    });
  });

  // Table-driven tests for all token types
  const tokenTestCases: Array<{
    type: WarpType;
    name: string;
    getConfig: () =>
      | RawNativeWarpArtifactConfig
      | RawCollateralWarpArtifactConfig
      | RawSyntheticWarpArtifactConfig;
    expectedFields?: Record<string, any>;
  }> = [
    {
      type: AltVM.TokenType.native,
      name: 'native',
      getConfig: () => ({
        type: AltVM.TokenType.native,
        owner: aleoSigner.getSignerAddress(),
        mailbox: mailboxAddress,
        remoteRouters: {},
        destinationGas: {},
      }),
    },
    {
      type: AltVM.TokenType.collateral,
      name: 'collateral',
      getConfig: () => ({
        type: AltVM.TokenType.collateral,
        owner: aleoSigner.getSignerAddress(),
        mailbox: mailboxAddress,
        token: '1field',
        remoteRouters: {},
        destinationGas: {},
      }),
      expectedFields: {
        token: '1field',
        name: 'Test Token',
        symbol: 'TEST',
        decimals: 6,
      },
    },
    {
      type: AltVM.TokenType.synthetic,
      name: 'synthetic',
      getConfig: () => ({
        type: AltVM.TokenType.synthetic,
        owner: aleoSigner.getSignerAddress(),
        mailbox: mailboxAddress,
        name: 'Synthetic Token',
        symbol: 'SYNTH',
        decimals: 18,
        remoteRouters: {},
        destinationGas: {},
      }),
      expectedFields: {
        name: 'Synthetic Token',
        symbol: 'SYNTH',
        decimals: 18,
      },
    },
  ];

  tokenTestCases.forEach(({ type, name, getConfig, expectedFields }) => {
    describe(`${name} token`, () => {
      it('should create and read token', async () => {
        const config = getConfig();

        const writer = artifactManager.createWriter(type, aleoSigner);
        const [result, receipts] = await writer.create({ config });

        expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
        expect(result.config.type).to.equal(type);
        expect(result.deployed.address).to.be.a('string').and.not.be.empty;
        expect(receipts).to.be.an('array').with.length.greaterThan(0);

        // Read back the token
        const reader = artifactManager.createReader(type);
        const readToken = await reader.read(result.deployed.address);

        expect(readToken.artifactState).to.equal(ArtifactState.DEPLOYED);
        expect(readToken.config.type).to.equal(type);
        expect(readToken.deployed.address).to.equal(result.deployed.address);

        // Verify expected fields
        if (expectedFields) {
          for (const [field, expectedValue] of Object.entries(expectedFields)) {
            expect((readToken.config as any)[field]).to.equal(expectedValue);
          }
        }
      });

      it('should enroll remote routers', async () => {
        const initialConfig = getConfig();

        const writer = artifactManager.createWriter(type, aleoSigner);
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
                  '0xe98b09dff7176053c651a4dc025af3e4f6a442415e9b85dd076ac0ff66b4b1ed',
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
          '0xe98b09dff7176053c651a4dc025af3e4f6a442415e9b85dd076ac0ff66b4b1ed',
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

        const writer = artifactManager.createWriter(type, aleoSigner);
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

        const writer = artifactManager.createWriter(type, aleoSigner);
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
          eqAddressAleo(
            readToken2.config.remoteRouters[DOMAIN_1].address,
            routerAddress,
          ),
        ).to.be.true;
      });

      it('should transfer ownership via update (ownership last)', async () => {
        const initialConfig = getConfig();

        const writer = artifactManager.createWriter(type, aleoSigner);
        const [deployedToken] = await writer.create({
          config: initialConfig,
        });

        const customIsmAddress = TEST_ALEO_BURN_ADDRESS;

        // Update routers, ISM, AND ownership
        const updatedConfig: ArtifactDeployed<
          WarpArtifactConfig,
          DeployedWarpAddress
        > = {
          ...deployedToken,
          config: {
            ...deployedToken.config,
            owner: TEST_ALEO_BURN_ADDRESS,
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
        expect(readToken.config.interchainSecurityModule?.deployed.address).to
          .be.undefined;
        expect(eqAddressAleo(readToken.config.owner, TEST_ALEO_BURN_ADDRESS)).to
          .be.true;
      });

      it('should return no update transactions when config is unchanged', async () => {
        const config = getConfig();

        const writer = artifactManager.createWriter(type, aleoSigner);
        const [deployedToken] = await writer.create({ config });

        const txs = await writer.update(deployedToken);
        expect(txs).to.be.an('array').with.length(0);
      });

      describe('ISM updates', function () {
        it('should unset ISM when changed from address to undefined', async () => {
          const initialConfig = getConfig();

          const { ismAddress } = await aleoSigner.createNoopIsm({});
          const customIsmAddress = ismAddress;

          // Create with ISM set
          initialConfig.interchainSecurityModule = {
            artifactState: ArtifactState.UNDERIVED,
            deployed: {
              address: customIsmAddress,
            },
          };

          const writer = artifactManager.createWriter(type, aleoSigner);
          const [deployedToken] = await writer.create({
            config: initialConfig,
          });

          // Verify ISM is set
          const reader = artifactManager.createReader(type);
          const readToken1 = await reader.read(deployedToken.deployed.address);
          assert(
            readToken1.config.interchainSecurityModule?.deployed.address,
            'ISM address should exist',
          );
          expect(
            eqAddressAleo(
              readToken1.config.interchainSecurityModule.deployed.address,
              customIsmAddress,
            ),
          ).to.be.true;

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

          const writer = artifactManager.createWriter(type, aleoSigner);
          const [deployedToken] = await writer.create({
            config: initialConfig,
          });

          // Verify ISM is unset
          const reader = artifactManager.createReader(type);
          const readToken1 = await reader.read(deployedToken.deployed.address);
          expect(readToken1.config.interchainSecurityModule).to.be.undefined;

          // Update to set ISM
          const { ismAddress } = await aleoSigner.createNoopIsm({});
          const customIsmAddress = ismAddress;

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
            'ISM address should exist',
          );
          expect(
            eqAddressAleo(
              readToken2.config.interchainSecurityModule.deployed.address,
              customIsmAddress,
            ),
          ).to.be.true;
        });

        it('should change ISM when updated to different address', async () => {
          const initialConfig = getConfig();

          const { ismAddress: firstIsmAddress } =
            await aleoSigner.createNoopIsm({});
          const { ismAddress: secondIsmAddress } =
            await aleoSigner.createNoopIsm({});

          // Create with first ISM
          initialConfig.interchainSecurityModule = {
            artifactState: ArtifactState.UNDERIVED,
            deployed: {
              address: firstIsmAddress,
            },
          };

          const writer = artifactManager.createWriter(type, aleoSigner);
          const [deployedToken] = await writer.create({
            config: initialConfig,
          });

          // Verify first ISM is set
          const reader = artifactManager.createReader(type);
          const readToken1 = await reader.read(deployedToken.deployed.address);

          assert(
            readToken1.config.interchainSecurityModule?.deployed.address,
            'ISM address should exist',
          );
          expect(
            eqAddressAleo(
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
            'ISM address should exist',
          );
          expect(
            eqAddressAleo(
              readToken2.config.interchainSecurityModule.deployed.address,
              secondIsmAddress,
            ),
          ).to.be.true;
        });

        it('should not generate ISM update tx when ISM unchanged', async () => {
          const initialConfig = getConfig();
          const customIsmAddress = TEST_ALEO_BURN_ADDRESS;

          // Create with ISM
          initialConfig.interchainSecurityModule = {
            artifactState: ArtifactState.UNDERIVED,
            deployed: {
              address: customIsmAddress,
            },
          };

          const writer = artifactManager.createWriter(type, aleoSigner);
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

          const writer = artifactManager.createWriter(type, aleoSigner);
          const [deployedToken] = await writer.create({
            config: initialConfig,
          });

          // Update with ISM still undefined (no change)
          const txs = await writer.update(deployedToken);

          // Should have no transactions (ISM still undefined)
          expect(txs).to.be.an('array').with.length(0);
        });
      });

      describe('Hook updates', function () {
        it('should unset hook when changed from address to undefined', async () => {
          const initialConfig = getConfig();

          const { hookAddress } = await aleoSigner.createMerkleTreeHook({
            mailboxAddress,
          });
          const customHookAddress = hookAddress;

          // Create with hook set
          initialConfig.hook = {
            artifactState: ArtifactState.UNDERIVED,
            deployed: {
              address: customHookAddress,
            },
          };

          const writer = artifactManager.createWriter(type, aleoSigner);
          const [deployedToken] = await writer.create({
            config: initialConfig,
          });

          // Verify hook is set
          const reader = artifactManager.createReader(type);
          const readToken1 = await reader.read(deployedToken.deployed.address);
          assert(
            readToken1.config.hook?.deployed.address,
            'Hook address should exist',
          );
          expect(
            eqAddressAleo(
              readToken1.config.hook.deployed.address,
              customHookAddress,
            ),
          ).to.be.true;

          // Update to clear hook (set to undefined)
          const updatedConfig: ArtifactDeployed<any, DeployedWarpAddress> = {
            ...deployedToken,
            config: {
              ...deployedToken.config,
              hook: undefined,
            },
          };

          const txs = await writer.update(updatedConfig);
          expect(txs).to.be.an('array').with.length.greaterThan(0);

          // Execute update
          for (const tx of txs) {
            await providerSdkSigner.sendAndConfirmTransaction(tx);
          }

          // Verify hook is now unset
          const readToken2 = await reader.read(deployedToken.deployed.address);
          expect(readToken2.config.hook).to.be.undefined;
        });

        it('should set hook when changed from undefined to address', async () => {
          const initialConfig = getConfig();
          // Start with no hook
          initialConfig.hook = undefined;

          const writer = artifactManager.createWriter(type, aleoSigner);
          const [deployedToken] = await writer.create({
            config: initialConfig,
          });

          // Verify hook is unset
          const reader = artifactManager.createReader(type);
          const readToken1 = await reader.read(deployedToken.deployed.address);
          expect(readToken1.config.hook).to.be.undefined;

          // Update to set hook
          const { hookAddress } = await aleoSigner.createMerkleTreeHook({
            mailboxAddress,
          });
          const customHookAddress = hookAddress;

          const updatedConfig: ArtifactDeployed<any, DeployedWarpAddress> = {
            ...deployedToken,
            config: {
              ...deployedToken.config,
              hook: {
                artifactState: ArtifactState.UNDERIVED,
                deployed: {
                  address: customHookAddress,
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

          // Verify hook is now set
          const readToken2 = await reader.read(deployedToken.deployed.address);
          assert(
            readToken2.config.hook?.deployed.address,
            'Hook address should exist',
          );
          expect(
            eqAddressAleo(
              readToken2.config.hook.deployed.address,
              customHookAddress,
            ),
          ).to.be.true;
        });

        it('should change hook when updated to different address', async () => {
          const initialConfig = getConfig();

          const { hookAddress: firstHookAddress } =
            await aleoSigner.createMerkleTreeHook({
              mailboxAddress,
            });
          const { hookAddress: secondHookAddress } =
            await aleoSigner.createMerkleTreeHook({
              mailboxAddress,
            });

          // Create with first hook
          initialConfig.hook = {
            artifactState: ArtifactState.UNDERIVED,
            deployed: {
              address: firstHookAddress,
            },
          };

          const writer = artifactManager.createWriter(type, aleoSigner);
          const [deployedToken] = await writer.create({
            config: initialConfig,
          });

          // Verify first hook is set
          const reader = artifactManager.createReader(type);
          const readToken1 = await reader.read(deployedToken.deployed.address);

          assert(
            readToken1.config.hook?.deployed.address,
            'Hook address should exist',
          );
          expect(
            eqAddressAleo(
              readToken1.config.hook.deployed.address,
              firstHookAddress,
            ),
          ).to.be.true;

          // Update to second hook
          const updatedConfig: ArtifactDeployed<any, DeployedWarpAddress> = {
            ...deployedToken,
            config: {
              ...deployedToken.config,
              hook: {
                artifactState: ArtifactState.UNDERIVED,
                deployed: {
                  address: secondHookAddress,
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

          // Verify hook changed to second address
          const readToken2 = await reader.read(deployedToken.deployed.address);
          assert(
            readToken2.config.hook?.deployed.address,
            'Hook address should exist',
          );
          expect(
            eqAddressAleo(
              readToken2.config.hook.deployed.address,
              secondHookAddress,
            ),
          ).to.be.true;
        });

        it('should not generate hook update tx when hook unchanged', async () => {
          const initialConfig = getConfig();
          const customHookAddress = TEST_ALEO_BURN_ADDRESS;

          // Create with hook
          initialConfig.hook = {
            artifactState: ArtifactState.UNDERIVED,
            deployed: {
              address: customHookAddress,
            },
          };

          const writer = artifactManager.createWriter(type, aleoSigner);
          const [deployedToken] = await writer.create({
            config: initialConfig,
          });

          // Update with same hook (no change)
          const txs = await writer.update(deployedToken);

          // Should have no transactions (hook unchanged)
          expect(txs).to.be.an('array').with.length(0);
        });

        it('should not generate hook update tx when both undefined', async () => {
          const initialConfig = getConfig();
          // Create without hook
          initialConfig.hook = undefined;

          const writer = artifactManager.createWriter(type, aleoSigner);
          const [deployedToken] = await writer.create({
            config: initialConfig,
          });

          // Update with hook still undefined (no change)
          const txs = await writer.update(deployedToken);

          // Should have no transactions (hook still undefined)
          expect(txs).to.be.an('array').with.length(0);
        });
      });
    });
  });

  describe('Generic warp token reading via readWarpToken', () => {
    tokenTestCases.forEach(({ type, name, getConfig }) => {
      it(`should detect and read ${name} token`, async () => {
        const config = getConfig();

        const writer = artifactManager.createWriter(type, aleoSigner);
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
