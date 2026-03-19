import { address, type Address } from '@solana/kit';
import { expect } from 'chai';
import { before, describe, it } from 'mocha';

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

    it('should deploy with CC routers and read them back', async () => {
      const ccRouters: Record<number, Set<string>> = {
        1: new Set([
          '0x1111111111111111111111111111111111111111111111111111111111111111',
        ]),
        2: new Set([
          '0x2222222222222222222222222222222222222222222222222222222222222222',
          '0x3333333333333333333333333333333333333333333333333333333333333333',
        ]),
      };

      const [deployed] = await writer.create({
        config: {
          type: TokenType.crossCollateral,
          owner: signer.getSignerAddress(),
          mailbox: mailboxAddress,
          token: collateralMint,
          remoteRouters: {},
          destinationGas: {},
          crossCollateralRouters: ccRouters,
        },
      });

      const onChain = await writer.read(deployed.deployed.address);
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
    });

    it('should enroll CC routers via update', async () => {
      const current = await writer.read(deployedProgramId);
      expect(Object.keys(current.config.crossCollateralRouters)).to.have.length(
        0,
      );

      const updateTxs = await writer.update({
        ...current,
        config: {
          ...current.config,
          crossCollateralRouters: {
            1: new Set([
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
      const domain1 = updated.config.crossCollateralRouters[1];
      expect(domain1).to.not.be.undefined;
      expect(domain1?.size).to.equal(1);
      expect(
        domain1?.has(
          '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        ),
      ).to.be.true;
    });

    it('should unenroll CC routers via update', async () => {
      const current = await writer.read(deployedProgramId);
      expect(current.config.crossCollateralRouters[1]).to.not.be.undefined;

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
      expect(Object.keys(updated.config.crossCollateralRouters)).to.have.length(
        0,
      );
    });
  });
});
