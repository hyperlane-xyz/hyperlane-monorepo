import { address } from '@solana/kit';
import { expect } from 'chai';
import { before, describe, it } from 'mocha';

import { FeeType, FeeStrategyType } from '@hyperlane-xyz/provider-sdk/fee';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';

import { SvmSigner } from '../clients/signer.js';
import {
  SvmCrossCollateralRoutingFeeReader,
  SvmCrossCollateralRoutingFeeWriter,
} from '../fee/cross-collateral-routing-fee.js';
import { DEFAULT_FEE_SALT } from '../fee/types.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { airdropSol } from '../testing/setup.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

const ROUTER_A =
  '0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ROUTER_B =
  '0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const ALL_CONTEXT = {
  knownRoutersPerDomain: {
    10: new Set([ROUTER_A, ROUTER_B]),
    20: new Set([ROUTER_A]),
  },
};

describe('SVM CrossCollateralRouting Fee E2E Tests', function () {
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

  it('should create and read CC routing fee with multiple (domain, router) pairs', async () => {
    const [deployed, receipts] = await writer.create({
      config: {
        type: FeeType.crossCollateralRouting,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        routes: {
          10: {
            [ROUTER_A]: {
              type: FeeStrategyType.linear,
              maxFee: '1000',
              halfAmount: '500',
            },
            [ROUTER_B]: {
              type: FeeStrategyType.regressive,
              maxFee: '2000',
              halfAmount: '1000',
            },
          },
          20: {
            [ROUTER_A]: {
              type: FeeStrategyType.progressive,
              maxFee: '3000',
              halfAmount: '1500',
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
    expect(readResult.config.routes[10]?.[ROUTER_A]?.maxFee).to.equal('1000');
    expect(readResult.config.routes[10]?.[ROUTER_B]?.type).to.equal(
      FeeStrategyType.regressive,
    );
    expect(readResult.config.routes[20]?.[ROUTER_A]?.type).to.equal(
      FeeStrategyType.progressive,
    );
  });

  it('should add a new (domain, router) pair via update', async () => {
    const [deployed] = await writer.create({
      config: {
        type: FeeType.crossCollateralRouting,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        routes: {
          10: {
            [ROUTER_A]: {
              type: FeeStrategyType.linear,
              maxFee: '1000',
              halfAmount: '500',
            },
          },
        },
      },
    });

    // 2 SetCCRoute (existing re-set + new) + 1 SetWildcardQuoteSigners = 3
    const updateTxs = await writer.update({
      ...deployed,
      config: {
        ...deployed.config,
        routes: {
          10: {
            [ROUTER_A]: {
              type: FeeStrategyType.linear,
              maxFee: '1000',
              halfAmount: '500',
            },
            [ROUTER_B]: {
              type: FeeStrategyType.progressive,
              maxFee: '5000',
              halfAmount: '2500',
            },
          },
        },
      },
    });

    expect(updateTxs).to.have.length(3);
    for (const tx of updateTxs) {
      await signer.send(tx);
    }

    const reader = new SvmCrossCollateralRoutingFeeReader(
      rpc,
      ALL_CONTEXT,
      DEFAULT_FEE_SALT,
    );
    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.routes[10]?.[ROUTER_B]?.type).to.equal(
      FeeStrategyType.progressive,
    );
    expect(readResult.config.routes[10]?.[ROUTER_B]?.maxFee).to.equal('5000');
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
              maxFee: '1000',
              halfAmount: '500',
            },
          },
        },
      },
    });

    // 1 SetCCRoute + 1 SetWildcardQuoteSigners = 2
    const updateTxs = await writer.update({
      ...deployed,
      config: {
        ...deployed.config,
        routes: {
          10: {
            [ROUTER_A]: {
              type: FeeStrategyType.linear,
              maxFee: '7777',
              halfAmount: '3333',
            },
          },
        },
      },
    });

    expect(updateTxs).to.have.length(2);
    for (const tx of updateTxs) {
      await signer.send(tx);
    }

    const reader = new SvmCrossCollateralRoutingFeeReader(
      rpc,
      ALL_CONTEXT,
      DEFAULT_FEE_SALT,
    );
    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.routes[10]?.[ROUTER_A]?.maxFee).to.equal('7777');
    expect(readResult.config.routes[10]?.[ROUTER_A]?.halfAmount).to.equal(
      '3333',
    );
  });

  it('should change strategy type on an existing CC route', async () => {
    const [deployed] = await writer.create({
      config: {
        type: FeeType.crossCollateralRouting,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        routes: {
          10: {
            [ROUTER_A]: {
              type: FeeStrategyType.linear,
              maxFee: '1000',
              halfAmount: '500',
            },
          },
        },
      },
    });

    // 1 SetCCRoute + 1 SetWildcardQuoteSigners = 2
    const updateTxs = await writer.update({
      ...deployed,
      config: {
        ...deployed.config,
        routes: {
          10: {
            [ROUTER_A]: {
              type: FeeStrategyType.regressive,
              maxFee: '2000',
              halfAmount: '1000',
            },
          },
        },
      },
    });

    expect(updateTxs).to.have.length(2);
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

  it('should remove a CC route via update', async () => {
    const [deployed] = await writer.create({
      config: {
        type: FeeType.crossCollateralRouting,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        routes: {
          10: {
            [ROUTER_A]: {
              type: FeeStrategyType.linear,
              maxFee: '1000',
              halfAmount: '500',
            },
            [ROUTER_B]: {
              type: FeeStrategyType.linear,
              maxFee: '2000',
              halfAmount: '1000',
            },
          },
        },
      },
    });

    // 1 SetCCRoute (kept) + 1 RemoveCCRoute (removed) + 1 SetWildcardQuoteSigners = 3
    const updateTxs = await writer.update({
      ...deployed,
      config: {
        ...deployed.config,
        routes: {
          10: {
            [ROUTER_A]: {
              type: FeeStrategyType.linear,
              maxFee: '1000',
              halfAmount: '500',
            },
          },
        },
      },
    });

    expect(updateTxs).to.have.length(3);
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
