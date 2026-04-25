import { address } from '@solana/kit';
import { expect } from 'chai';
import { before, describe, it } from 'mocha';

import {
  FeeType,
  FeeStrategyType,
  FeeParamsKind,
} from '@hyperlane-xyz/provider-sdk/fee';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';

import { SvmSigner } from '../clients/signer.js';
import {
  SvmRoutingFeeReader,
  SvmRoutingFeeWriter,
} from '../fee/routing-fee.js';
import { DEFAULT_FEE_SALT } from '../fee/types.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { airdropSol } from '../testing/setup.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

const SIGNER_A = '0x1111111111111111111111111111111111111111';

// Context that covers all domains used in tests
const ALL_DOMAINS_CONTEXT = {
  knownRoutersPerDomain: {
    10: new Set<string>(),
    20: new Set<string>(),
    30: new Set<string>(),
  },
};

describe('SVM Routing Fee E2E Tests', function () {
  this.timeout(300_000);

  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let writer: SvmRoutingFeeWriter;

  before(async () => {
    rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    signer = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      TEST_PRIVATE_KEY,
    );
    await airdropSol(rpc, address(signer.getSignerAddress()), 100_000_000_000n);

    writer = new SvmRoutingFeeWriter(
      { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenFee } },
      rpc,
      1,
      signer,
      ALL_DOMAINS_CONTEXT,
      DEFAULT_FEE_SALT,
    );
  });

  it('should create and read a routing fee with multiple routes', async () => {
    const [deployed, receipts] = await writer.create({
      config: {
        type: FeeType.routing,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        routes: {
          10: {
            type: FeeStrategyType.linear,
            params: {
              kind: FeeParamsKind.raw,
              maxFee: '1000',
              halfAmount: '500',
            },
          },
          20: {
            type: FeeStrategyType.regressive,
            params: {
              kind: FeeParamsKind.raw,
              maxFee: '2000',
              halfAmount: '1000',
            },
          },
        },
      },
    });

    expect(receipts.length).to.be.greaterThan(0);
    expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);

    const reader = new SvmRoutingFeeReader(
      rpc,
      ALL_DOMAINS_CONTEXT,
      DEFAULT_FEE_SALT,
    );
    const readResult = await reader.read(deployed.deployed.programId);

    expect(readResult.config.type).to.equal(FeeType.routing);
    expect(readResult.config.routes[10]?.type).to.equal(FeeStrategyType.linear);
    expect(readResult.config.routes[10]?.params.maxFee).to.equal('1000');
    expect(readResult.config.routes[20]?.type).to.equal(
      FeeStrategyType.regressive,
    );
    expect(readResult.config.routes[20]?.params.maxFee).to.equal('2000');
    expect(readResult.config.routes[30]).to.be.undefined;
  });

  it('should create a route with offchainQuotedLinear strategy and read back signers', async () => {
    const [deployed] = await writer.create({
      config: {
        type: FeeType.routing,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        routes: {
          10: {
            type: FeeStrategyType.offchainQuotedLinear,
            params: {
              kind: FeeParamsKind.raw,
              maxFee: '5000',
              halfAmount: '2500',
            },
            quoteSigners: [SIGNER_A],
          },
        },
      },
    });

    const reader = new SvmRoutingFeeReader(
      rpc,
      ALL_DOMAINS_CONTEXT,
      DEFAULT_FEE_SALT,
    );
    const readResult = await reader.read(deployed.deployed.programId);

    const route = readResult.config.routes[10];
    expect(route?.type).to.equal(FeeStrategyType.offchainQuotedLinear);
    if (route?.type === FeeStrategyType.offchainQuotedLinear) {
      expect(route.quoteSigners).to.have.length(1);
      expect(route.quoteSigners[0]?.toLowerCase()).to.equal(
        SIGNER_A.toLowerCase(),
      );
    }
  });

  it('should add a new route via update', async () => {
    const [deployed] = await writer.create({
      config: {
        type: FeeType.routing,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        routes: {
          10: {
            type: FeeStrategyType.linear,
            params: {
              kind: FeeParamsKind.raw,
              maxFee: '1000',
              halfAmount: '500',
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
            type: FeeStrategyType.linear,
            params: {
              kind: FeeParamsKind.raw,
              maxFee: '1000',
              halfAmount: '500',
            },
          },
          20: {
            type: FeeStrategyType.progressive,
            params: {
              kind: FeeParamsKind.raw,
              maxFee: '3000',
              halfAmount: '1500',
            },
          },
        },
      },
    });

    expect(updateTxs.length).to.be.greaterThan(0);
    for (const tx of updateTxs) {
      await signer.send(tx);
    }

    const reader = new SvmRoutingFeeReader(
      rpc,
      ALL_DOMAINS_CONTEXT,
      DEFAULT_FEE_SALT,
    );
    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.routes[20]?.type).to.equal(
      FeeStrategyType.progressive,
    );
    expect(readResult.config.routes[20]?.params.maxFee).to.equal('3000');
  });

  it('should update params on an existing route', async () => {
    const [deployed] = await writer.create({
      config: {
        type: FeeType.routing,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        routes: {
          10: {
            type: FeeStrategyType.linear,
            params: {
              kind: FeeParamsKind.raw,
              maxFee: '1000',
              halfAmount: '500',
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
            type: FeeStrategyType.linear,
            params: {
              kind: FeeParamsKind.raw,
              maxFee: '9999',
              halfAmount: '4444',
            },
          },
        },
      },
    });

    expect(updateTxs.length).to.be.greaterThan(0);
    for (const tx of updateTxs) {
      await signer.send(tx);
    }

    const reader = new SvmRoutingFeeReader(
      rpc,
      ALL_DOMAINS_CONTEXT,
      DEFAULT_FEE_SALT,
    );
    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.routes[10]?.params.maxFee).to.equal('9999');
    expect(readResult.config.routes[10]?.params.halfAmount).to.equal('4444');
  });

  it('should change an existing route strategy type', async () => {
    const [deployed] = await writer.create({
      config: {
        type: FeeType.routing,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        routes: {
          10: {
            type: FeeStrategyType.linear,
            params: {
              kind: FeeParamsKind.raw,
              maxFee: '1000',
              halfAmount: '500',
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
            type: FeeStrategyType.regressive,
            params: {
              kind: FeeParamsKind.raw,
              maxFee: '2000',
              halfAmount: '1000',
            },
          },
        },
      },
    });

    expect(updateTxs.length).to.be.greaterThan(0);
    for (const tx of updateTxs) {
      await signer.send(tx);
    }

    const reader = new SvmRoutingFeeReader(
      rpc,
      ALL_DOMAINS_CONTEXT,
      DEFAULT_FEE_SALT,
    );
    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.routes[10]?.type).to.equal(
      FeeStrategyType.regressive,
    );
    expect(readResult.config.routes[10]?.params.maxFee).to.equal('2000');
  });

  it('should remove a route via update', async () => {
    const [deployed] = await writer.create({
      config: {
        type: FeeType.routing,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        routes: {
          10: {
            type: FeeStrategyType.linear,
            params: {
              kind: FeeParamsKind.raw,
              maxFee: '1000',
              halfAmount: '500',
            },
          },
          20: {
            type: FeeStrategyType.linear,
            params: {
              kind: FeeParamsKind.raw,
              maxFee: '2000',
              halfAmount: '1000',
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
            type: FeeStrategyType.linear,
            params: {
              kind: FeeParamsKind.raw,
              maxFee: '1000',
              halfAmount: '500',
            },
          },
        },
      },
    });

    expect(updateTxs.length).to.be.greaterThan(0);
    for (const tx of updateTxs) {
      await signer.send(tx);
    }

    const reader = new SvmRoutingFeeReader(
      rpc,
      ALL_DOMAINS_CONTEXT,
      DEFAULT_FEE_SALT,
    );
    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.routes[10]).to.exist;
    expect(readResult.config.routes[20]).to.be.undefined;
  });
});
