import { address, type Address } from '@solana/kit';
import { expect } from 'chai';
import { before, describe, it } from 'mocha';
import { step } from 'mocha-steps';

import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import type { IgpHookConfig } from '@hyperlane-xyz/provider-sdk/hook';
import { TokenType } from '@hyperlane-xyz/provider-sdk/warp';

import { SvmSigner } from '../clients/signer.js';
import { SvmMailboxWriter } from '../core/mailbox.js';
import { DEFAULT_IGP_SALT, SvmIgpHookWriter } from '../hook/igp-hook.js';
import { SvmTestIsmWriter } from '../ism/test-ism.js';
import { deriveAtaPayerPda } from '../pda.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import {
  TEST_ATA_PAYER_FUNDING_AMOUNT,
  TEST_PROGRAM_IDS,
  airdropSol,
  createSplMint,
} from '../testing/setup.js';
import { SvmCrossCollateralTokenWriter } from '../warp/cross-collateral-token.js';

import { defineWarpTokenTests } from './warp-token-suite.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

describe('SVM Cross-Collateral Warp Token E2E Tests', function () {
  this.timeout(300_000);

  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let mailboxAddress: Address;
  let collateralMint: Address;
  let igpProgramId: Address;
  let testIsmAddress: Address;
  let writer: SvmCrossCollateralTokenWriter;

  before(async () => {
    rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    signer = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      TEST_PRIVATE_KEY,
    );
    await airdropSol(rpc, address(signer.getSignerAddress()), 50_000_000_000n);

    mailboxAddress = TEST_PROGRAM_IDS.mailbox;
    igpProgramId = TEST_PROGRAM_IDS.igp;

    const igpConfig: IgpHookConfig = {
      type: 'interchainGasPaymaster',
      owner: signer.getSignerAddress(),
      beneficiary: signer.getSignerAddress(),
      oracleKey: signer.getSignerAddress(),
      overhead: { 1: 50000 },
      oracleConfig: {
        1: { gasPrice: '1', tokenExchangeRate: '1000000000000000000' },
      },
    };
    const igpWriter = new SvmIgpHookWriter(
      { program: { programId: igpProgramId } },
      rpc,
      DEFAULT_IGP_SALT,
      signer,
    );
    await igpWriter.create({
      artifactState: ArtifactState.NEW,
      config: igpConfig,
    });

    testIsmAddress = TEST_PROGRAM_IDS.testIsm;
    const ismWriter = new SvmTestIsmWriter(
      { program: { programId: testIsmAddress } },
      rpc,
      signer,
    );
    await ismWriter.create({
      artifactState: ArtifactState.NEW,
      config: { type: 'testIsm' },
    });

    // Initialize mailbox — CC init reads localDomain from the outbox PDA
    const mailboxWriter = new SvmMailboxWriter(
      {
        program: { programId: mailboxAddress },
        domainId: TEST_SVM_CHAIN_METADATA.domainId,
      },
      rpc,
      signer,
    );
    await mailboxWriter.create({
      config: {
        owner: signer.getSignerAddress(),
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: testIsmAddress },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: mailboxAddress },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: mailboxAddress },
        },
      },
    });

    collateralMint = await createSplMint(rpc, signer, 9);

    writer = new SvmCrossCollateralTokenWriter(
      {
        program: {
          programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenCrossCollateral,
        },
        ataPayerFundingAmount: TEST_ATA_PAYER_FUNDING_AMOUNT,
      },
      rpc,
      signer,
    );
  });

  describe('Cross-Collateral Token', () => {
    let deployedProgramId: string;

    defineWarpTokenTests(
      () => ({
        writer,
        makeConfig: (overrides = {}) => ({
          type: TokenType.crossCollateral,
          owner: signer.getSignerAddress(),
          mailbox: mailboxAddress,
          token: collateralMint,
          remoteRouters: {},
          destinationGas: {},
          crossCollateralRouters: {},
          ...overrides,
        }),
        igpProgramId,
        testIsmAddress,
        signer,
        rpc,
        rpcUrl: TEST_SVM_CHAIN_METADATA.rpcUrl,
      }),
      (id) => {
        deployedProgramId = id;
      },
    );

    it('should fund ATA payer PDA after deploy', async () => {
      const { address: ataPayerPda } = await deriveAtaPayerPda(
        address(deployedProgramId),
      );
      const balance = await rpc.getBalance(ataPayerPda).send();
      expect(BigInt(balance.value) >= TEST_ATA_PAYER_FUNDING_AMOUNT).to.be.true;
    });

    it('should have correct collateral token address after deploy', async () => {
      const token = await writer.read(deployedProgramId);
      expect(token.config.token).to.equal(collateralMint);
      expect(token.config.mailbox).to.equal(mailboxAddress);
    });

    describe('Cross collateral token', function () {
      step(
        'should enroll CC routers via update and read them back',
        async () => {
          const current = await writer.read(deployedProgramId);
          expect(
            Object.keys(current.config.crossCollateralRouters),
          ).to.have.length(0);

          const ccRouters: Record<number, Set<string>> = {
            1: new Set([
              '0x1111111111111111111111111111111111111111111111111111111111111111',
            ]),
            2: new Set([
              '0x2222222222222222222222222222222222222222222222222222222222222222',
              '0x3333333333333333333333333333333333333333333333333333333333333333',
            ]),
          };

          const updateTxs = await writer.update({
            ...current,
            config: {
              ...current.config,
              crossCollateralRouters: ccRouters,
            },
          });

          expect(updateTxs.length).to.be.greaterThan(0);
          for (const tx of updateTxs) {
            await signer.send({ instructions: tx.instructions });
          }

          const onChain = await writer.read(deployedProgramId);
          const domain1Routers = onChain.config.crossCollateralRouters[1];
          expect(domain1Routers).to.not.be.undefined;
          expect(domain1Routers?.size).to.equal(1);
          expect(
            domain1Routers?.has(
              '0x1111111111111111111111111111111111111111111111111111111111111111',
            ),
          ).to.be.true;

          const domain2Routers = onChain.config.crossCollateralRouters[2];
          expect(domain2Routers).to.not.be.undefined;
          expect(domain2Routers?.size).to.equal(2);
        },
      );

      step('should enroll additional CC routers via update', async () => {
        const current = await writer.read(deployedProgramId);
        expect(
          Object.keys(current.config.crossCollateralRouters),
        ).to.have.length(2);

        const updateTxs = await writer.update({
          ...current,
          config: {
            ...current.config,
            crossCollateralRouters: {
              ...current.config.crossCollateralRouters,
              3: new Set([
                '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              ]),
            },
          },
        });

        expect(updateTxs.length).to.be.greaterThan(0);
        for (const tx of updateTxs) {
          await signer.send({ instructions: tx.instructions });
        }

        const updated = await writer.read(deployedProgramId);
        expect(
          Object.keys(updated.config.crossCollateralRouters),
        ).to.have.length(3);
        expect(updated.config.crossCollateralRouters[1]?.size).to.equal(1);
        expect(updated.config.crossCollateralRouters[2]?.size).to.equal(2);
        const domain3 = updated.config.crossCollateralRouters[3];
        expect(domain3).to.not.be.undefined;
        expect(domain3?.size).to.equal(1);
        expect(
          domain3?.has(
            '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          ),
        ).to.be.true;
      });

      step('should unenroll all CC routers via update', async () => {
        const current = await writer.read(deployedProgramId);
        expect(
          Object.keys(current.config.crossCollateralRouters),
        ).to.have.length(3);

        const updateTxs = await writer.update({
          ...current,
          config: {
            ...current.config,
            crossCollateralRouters: {},
          },
        });

        expect(updateTxs.length).to.be.greaterThan(0);
        for (const tx of updateTxs) {
          await signer.send({ instructions: tx.instructions });
        }

        const updated = await writer.read(deployedProgramId);
        expect(
          Object.keys(updated.config.crossCollateralRouters),
        ).to.have.length(0);
      });

      step(
        'should canonicalize CC routers from mixed-case, EVM, and Solana addresses to hex32',
        async () => {
          // Three address formats that should all be canonicalized to lowercase hex32
          const MIXED_CASE_HEX32 =
            '0xAABBCCDD00000000000000000000000000000000000000000000000000000001';
          const EVM_20BYTE = '0x1234567890abcdef1234567890abcdef12345678';
          const SOLANA_BASE58 = 'zUeFx6cfxedG2JnFtMKkTXnxgPa5M44tyaF9RrPunCp';

          // Expected canonical forms (lowercase hex32)
          const CANONICAL_MIXED =
            '0xaabbccdd00000000000000000000000000000000000000000000000000000001';
          const CANONICAL_EVM =
            '0x0000000000000000000000001234567890abcdef1234567890abcdef12345678';
          const CANONICAL_SOL =
            '0x0eb95c8804d3cd8d5bd3744147222d4d20727e6253f24e8051c7d2bf0ff99f21';

          // Enroll one router per domain, each in a different format
          const current = await writer.read(deployedProgramId);
          const enrollTxs = await writer.update({
            ...current,
            config: {
              ...current.config,
              crossCollateralRouters: {
                10: new Set([MIXED_CASE_HEX32]),
                11: new Set([EVM_20BYTE]),
                12: new Set([SOLANA_BASE58]),
              },
            },
          });

          expect(enrollTxs.length).to.be.greaterThan(0);
          for (const tx of enrollTxs) {
            await signer.send({ instructions: tx.instructions });
          }

          // Read back — all should be canonical lowercase hex32
          const afterEnroll = await writer.read(deployedProgramId);
          expect(
            afterEnroll.config.crossCollateralRouters[10]?.has(CANONICAL_MIXED),
          ).to.be.true;
          expect(
            afterEnroll.config.crossCollateralRouters[11]?.has(CANONICAL_EVM),
          ).to.be.true;
          expect(
            afterEnroll.config.crossCollateralRouters[12]?.has(CANONICAL_SOL),
          ).to.be.true;

          // Re-apply same non-canonical config — should produce no CC router txs
          const nochurnTxs = await writer.update({
            ...afterEnroll,
            config: {
              ...afterEnroll.config,
              crossCollateralRouters: {
                10: new Set([MIXED_CASE_HEX32]),
                11: new Set([EVM_20BYTE]),
                12: new Set([SOLANA_BASE58]),
              },
            },
          });

          const ccTxs = nochurnTxs.filter(
            (tx) =>
              tx.annotation?.includes('CC routers') ||
              tx.annotation?.includes('CC-only gas'),
          );
          expect(ccTxs).to.have.length(0);

          // Cleanup
          const cleanupTxs = await writer.update({
            ...afterEnroll,
            config: {
              ...afterEnroll.config,
              crossCollateralRouters: {},
            },
          });
          for (const tx of cleanupTxs) {
            await signer.send({ instructions: tx.instructions });
          }
        },
      );

      step(
        'should set destination gas for CC-only domains not in remoteRouters',
        async () => {
          const CC_ONLY_DOMAIN = 99;
          const CC_ROUTER =
            '0x5555555555555555555555555555555555555555555555555555555555555555';

          const current = await writer.read(deployedProgramId);

          // Verify domain 99 is not in remoteRouters
          expect(current.config.remoteRouters[CC_ONLY_DOMAIN]).to.be.undefined;

          // Enroll CC routers + gas for a CC-only domain
          const enrollTxs = await writer.update({
            ...current,
            config: {
              ...current.config,
              crossCollateralRouters: {
                [CC_ONLY_DOMAIN]: new Set([CC_ROUTER]),
              },
              destinationGas: {
                ...current.config.destinationGas,
                [CC_ONLY_DOMAIN]: '300000',
              },
            },
          });

          expect(enrollTxs.length).to.be.greaterThan(0);
          for (const tx of enrollTxs) {
            await signer.send({ instructions: tx.instructions });
          }

          const afterEnroll = await writer.read(deployedProgramId);
          expect(
            afterEnroll.config.crossCollateralRouters[CC_ONLY_DOMAIN]?.size,
          ).to.equal(1);
          expect(afterEnroll.config.destinationGas[CC_ONLY_DOMAIN]).to.equal(
            '300000',
          );
        },
      );

      step('should update destination gas for CC-only domains', async () => {
        const CC_ONLY_DOMAIN = 99;
        const CC_ROUTER =
          '0x5555555555555555555555555555555555555555555555555555555555555555';

        const current = await writer.read(deployedProgramId);

        const updateTxs = await writer.update({
          ...current,
          config: {
            ...current.config,
            crossCollateralRouters: {
              [CC_ONLY_DOMAIN]: new Set([CC_ROUTER]),
            },
            destinationGas: {
              ...current.config.destinationGas,
              [CC_ONLY_DOMAIN]: '500000',
            },
          },
        });

        expect(updateTxs.length).to.be.greaterThan(0);
        for (const tx of updateTxs) {
          await signer.send({ instructions: tx.instructions });
        }

        const afterUpdate = await writer.read(deployedProgramId);
        expect(afterUpdate.config.destinationGas[CC_ONLY_DOMAIN]).to.equal(
          '500000',
        );
      });

      step(
        'should unenroll destination gas when CC-only domain is removed',
        async () => {
          const CC_ONLY_DOMAIN = 99;

          const current = await writer.read(deployedProgramId);
          expect(current.config.destinationGas[CC_ONLY_DOMAIN]).to.exist;

          // Remove CC routers for domain 99 — gas should be unenrolled too
          const removeTxs = await writer.update({
            ...current,
            config: {
              ...current.config,
              crossCollateralRouters: {},
              destinationGas: (() => {
                const gas = { ...current.config.destinationGas };
                delete gas[CC_ONLY_DOMAIN];
                return gas;
              })(),
            },
          });

          expect(removeTxs.length).to.be.greaterThan(0);
          for (const tx of removeTxs) {
            await signer.send({ instructions: tx.instructions });
          }

          const afterRemove = await writer.read(deployedProgramId);
          expect(
            Object.keys(afterRemove.config.crossCollateralRouters),
          ).to.have.length(0);
          expect(afterRemove.config.destinationGas[CC_ONLY_DOMAIN]).to.be
            .undefined;
        },
      );
    });
  });
});
