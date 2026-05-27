import { address, generateKeyPairSigner } from '@solana/kit';
import { expect } from 'chai';
import { before, describe, it } from 'mocha';

import {
  FeeParamsType,
  FeeStrategyType,
  FeeType,
} from '@hyperlane-xyz/provider-sdk/fee';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { assert } from '@hyperlane-xyz/utils';

import { SvmSigner } from '../clients/signer.js';
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from '../constants.js';
import {
  SvmCrossCollateralRoutingFeeReader,
  SvmCrossCollateralRoutingFeeWriter,
} from '../fee/cross-collateral-routing-fee.js';
import { DEFAULT_FEE_SALT } from '../fee/types.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import { deriveAssociatedTokenAddress } from '../pda.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { airdropSol, createSplMint } from '../testing/setup.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

const raw = (maxFee: string, halfAmount: string) =>
  ({ type: FeeParamsType.raw, maxFee, halfAmount }) as const;

const ROUTER_A =
  '0x000000000000000000000000000000000000000000000000000000000000aaaa';
const ROUTER_B =
  '0x000000000000000000000000000000000000000000000000000000000000bbbb';

const ALL_CONTEXT = {
  knownRoutersPerDomain: {
    10: new Set([ROUTER_A, ROUTER_B]),
    20: new Set([ROUTER_A]),
  },
};

describe('SVM Cross-Collateral Routing Fee E2E Tests', function () {
  this.timeout(300_000);

  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let writer: SvmCrossCollateralRoutingFeeWriter;

  before(async () => {
    rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    signer = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      TEST_PRIVATE_KEY,
    );
    await airdropSol(rpc, address(signer.getSignerAddress()), 100_000_000_000n);

    writer = new SvmCrossCollateralRoutingFeeWriter(
      { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenFee } },
      rpc,
      1,
      signer,
      ALL_CONTEXT,
      DEFAULT_FEE_SALT,
    );
  });

  it('should create and read with multiple CC routes', async () => {
    const [deployed, receipts] = await writer.create({
      config: {
        type: FeeType.crossCollateralRouting,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        routes: {
          10: {
            [ROUTER_A]: {
              type: FeeStrategyType.linear,
              params: raw('1000', '500'),
            },
            [ROUTER_B]: {
              type: FeeStrategyType.regressive,
              params: raw('2000', '1000'),
            },
          },
        },
      },
    });

    expect(receipts.length).to.be.greaterThan(0);
    expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);

    const reader = new SvmCrossCollateralRoutingFeeReader(
      rpc,
      ALL_CONTEXT,
      DEFAULT_FEE_SALT,
    );
    const readResult = await reader.read(deployed.deployed.programId);

    expect(readResult.config.type).to.equal(FeeType.crossCollateralRouting);
    expect(readResult.config.routes[10]?.[ROUTER_A]?.type).to.equal(
      FeeStrategyType.linear,
    );
    expect(readResult.config.routes[10]?.[ROUTER_B]?.type).to.equal(
      FeeStrategyType.regressive,
    );
  });

  it('should create beneficiary ATA at fee deploy when token is set', async () => {
    const mint = await createSplMint(rpc, signer, 9);
    const beneficiary = await generateKeyPairSigner();

    await writer.create({
      config: {
        type: FeeType.crossCollateralRouting,
        owner: signer.getSignerAddress(),
        beneficiary: beneficiary.address,
        token: mint,
        routes: {
          10: {
            [ROUTER_A]: {
              type: FeeStrategyType.linear,
              params: raw('1000', '500'),
            },
          },
        },
      },
    });

    const expectedAta = await deriveAssociatedTokenAddress({
      wallet: beneficiary.address,
      mint,
    });
    const ataInfo = await rpc
      .getAccountInfo(expectedAta.address, { encoding: 'base64' })
      .send();
    expect(ataInfo.value).to.not.be.null;
  });

  it('should return empty transactions when config is unchanged', async () => {
    const [deployed] = await writer.create({
      config: {
        type: FeeType.crossCollateralRouting,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        routes: {
          10: {
            [ROUTER_A]: {
              type: FeeStrategyType.linear,
              params: raw('1000', '500'),
            },
          },
        },
      },
    });

    const updateTxs = await writer.update(deployed);
    expect(updateTxs).to.have.length(0);
  });

  it('should add a new CC route pair via update', async () => {
    const [deployed] = await writer.create({
      config: {
        type: FeeType.crossCollateralRouting,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        routes: {
          10: {
            [ROUTER_A]: {
              type: FeeStrategyType.linear,
              params: raw('1000', '500'),
            },
          },
        },
      },
    });

    const updateTxs = await writer.update({
      ...deployed,
      config: {
        ...deployed.config,
        routes: {
          10: {
            [ROUTER_A]: {
              type: FeeStrategyType.linear,
              params: raw('1000', '500'),
            },
          },
          20: {
            [ROUTER_A]: {
              type: FeeStrategyType.progressive,
              params: raw('3000', '1500'),
            },
          },
        },
      },
    });

    expect(updateTxs.length).to.be.greaterThan(0);
    for (const tx of updateTxs) {
      await signer.send(tx);
    }

    const reader = new SvmCrossCollateralRoutingFeeReader(
      rpc,
      ALL_CONTEXT,
      DEFAULT_FEE_SALT,
    );
    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.routes[20]?.[ROUTER_A]?.type).to.equal(
      FeeStrategyType.progressive,
    );
  });

  it('should update params on an existing CC route', async () => {
    const [deployed] = await writer.create({
      config: {
        type: FeeType.crossCollateralRouting,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        routes: {
          10: {
            [ROUTER_A]: {
              type: FeeStrategyType.linear,
              params: raw('1000', '500'),
            },
          },
        },
      },
    });

    const updateTxs = await writer.update({
      ...deployed,
      config: {
        ...deployed.config,
        routes: {
          10: {
            [ROUTER_A]: {
              type: FeeStrategyType.linear,
              params: raw('9999', '4444'),
            },
          },
        },
      },
    });

    for (const tx of updateTxs) {
      await signer.send(tx);
    }

    const reader = new SvmCrossCollateralRoutingFeeReader(
      rpc,
      ALL_CONTEXT,
      DEFAULT_FEE_SALT,
    );
    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.routes[10]?.[ROUTER_A]?.params.maxFee).to.equal(
      '9999',
    );
  });

  it('should change CC route strategy type', async () => {
    const [deployed] = await writer.create({
      config: {
        type: FeeType.crossCollateralRouting,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        routes: {
          10: {
            [ROUTER_A]: {
              type: FeeStrategyType.linear,
              params: raw('1000', '500'),
            },
          },
        },
      },
    });

    const updateTxs = await writer.update({
      ...deployed,
      config: {
        ...deployed.config,
        routes: {
          10: {
            [ROUTER_A]: {
              type: FeeStrategyType.regressive,
              params: raw('2000', '1000'),
            },
          },
        },
      },
    });

    for (const tx of updateTxs) {
      await signer.send(tx);
    }

    const reader = new SvmCrossCollateralRoutingFeeReader(
      rpc,
      ALL_CONTEXT,
      DEFAULT_FEE_SALT,
    );
    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.routes[10]?.[ROUTER_A]?.type).to.equal(
      FeeStrategyType.regressive,
    );
  });

  it('should update beneficiary and create ATA when token is set', async () => {
    const [deployed] = await writer.create({
      config: {
        type: FeeType.crossCollateralRouting,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        routes: {
          10: {
            [ROUTER_A]: {
              type: FeeStrategyType.linear,
              params: raw('1000', '500'),
            },
          },
        },
      },
    });

    const mint = await createSplMint(rpc, signer, 9);
    const newBeneficiary = await generateKeyPairSigner();
    const updateTxs = await writer.update({
      ...deployed,
      config: {
        ...deployed.config,
        beneficiary: newBeneficiary.address,
        token: mint,
      },
    });

    expect(updateTxs).to.have.length(1);
    const [updateTx] = updateTxs;
    assert(updateTx, 'expected one update tx');
    expect(updateTx.instructions).to.have.length(2);
    expect(updateTx.instructions[0]?.programAddress).to.equal(
      ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    );
    for (const tx of updateTxs) {
      await signer.send(tx);
    }

    const reader = new SvmCrossCollateralRoutingFeeReader(
      rpc,
      ALL_CONTEXT,
      DEFAULT_FEE_SALT,
    );
    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.beneficiary).to.equal(newBeneficiary.address);

    const expectedAta = await deriveAssociatedTokenAddress({
      wallet: newBeneficiary.address,
      mint,
    });
    const ataInfo = await rpc
      .getAccountInfo(expectedAta.address, { encoding: 'base64' })
      .send();
    expect(ataInfo.value).to.not.be.null;
  });

  it('should remove a CC route pair via update', async () => {
    const [deployed] = await writer.create({
      config: {
        type: FeeType.crossCollateralRouting,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        routes: {
          10: {
            [ROUTER_A]: {
              type: FeeStrategyType.linear,
              params: raw('1000', '500'),
            },
            [ROUTER_B]: {
              type: FeeStrategyType.linear,
              params: raw('2000', '1000'),
            },
          },
        },
      },
    });

    const updateTxs = await writer.update({
      ...deployed,
      config: {
        ...deployed.config,
        routes: {
          10: {
            [ROUTER_A]: {
              type: FeeStrategyType.linear,
              params: raw('1000', '500'),
            },
          },
        },
      },
    });

    for (const tx of updateTxs) {
      await signer.send(tx);
    }

    const reader = new SvmCrossCollateralRoutingFeeReader(
      rpc,
      ALL_CONTEXT,
      DEFAULT_FEE_SALT,
    );
    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.routes[10]?.[ROUTER_A]).to.exist;
    expect(readResult.config.routes[10]?.[ROUTER_B]).to.be.undefined;
  });
});
