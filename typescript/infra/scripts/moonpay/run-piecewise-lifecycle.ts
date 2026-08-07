#!/usr/bin/env tsx

import { readFile } from 'node:fs/promises';

import { Wallet, constants, ethers } from 'ethers';
import { parse as parseYaml } from 'yaml';
import yargs from 'yargs';

import { confirm } from '@inquirer/prompts';
import {
  CrossCollateralRouter__factory,
  IERC20__factory,
  OffchainQuotedPiecewiseLinearFee__factory,
} from '@hyperlane-xyz/core';
import { getRegistry as getMergedRegistry } from '@hyperlane-xyz/registry/fs';
import { MultiProvider } from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert } from '@hyperlane-xyz/utils';

import { getRegistry } from '../../config/registry.js';

import {
  GCP_DEPLOYER_SECRET,
  GCP_SIGNER_SECRET,
  WILDCARD_RECIPIENT,
  resolveGcpKey,
} from './oqlf-lib.js';
import {
  type LaneRegistry,
  EvmLaneOnchainReader,
  discoverPiecewiseLane,
  getLatestBlockTimestamp,
  parsePiecewisePublisherConfig,
  prepareLaneUpdate,
  selectPublisherLanes,
  submitPreparedUpdate,
  verifyPiecewiseSignerAuthorization,
} from './piecewise-fee-lib.js';
import {
  type LifecyclePhase,
  type LifecycleQuote,
  type StandingTiming,
  STAGING_LIFECYCLE_LANE_ID,
  STAGING_TOKEN_ALLOWANCE_CAP,
  STAGING_TRANSFER_AMOUNT,
  assertExactRouterConfirmations,
  assertStagingLifecycleLane,
  pollForBlockTimestamp,
  runStagingLifecycle,
} from './piecewise-fee-lifecycle-lib.js';

const DEFAULT_CONFIG =
  'config/environments/mainnet3/warp/fees/moonpay-staging-piecewise.yaml';

interface RawLifecycleQuote {
  destination: number;
  recipient: string;
  targetRouter: string;
}

function valuesEqual(
  actual: readonly ethers.BigNumberish[],
  expected: readonly ethers.BigNumberish[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) =>
      ethers.BigNumber.from(value).eq(expected[index]),
    )
  );
}

function toStandingTiming(curve: {
  issuedAt: ethers.BigNumberish;
  staleAfterSeconds: ethers.BigNumberish;
  expiry: ethers.BigNumberish;
}): StandingTiming {
  return {
    issuedAt: ethers.BigNumber.from(curve.issuedAt).toNumber(),
    staleAfterSeconds: ethers.BigNumber.from(
      curve.staleAfterSeconds,
    ).toNumber(),
    expiry: ethers.BigNumber.from(curve.expiry).toNumber(),
  };
}

async function main(): Promise<void> {
  const args = await yargs(process.argv.slice(2))
    .option('config', {
      alias: 'c',
      type: 'string',
      default: DEFAULT_CONFIG,
      describe: 'Piecewise staging curve YAML file',
    })
    .option('registry', {
      alias: 'r',
      type: 'string',
      describe: 'Registry URI (local path or http://...)',
    })
    .option('recipient', {
      type: 'string',
      demandOption: true,
      describe: 'Explicit Arbitrum recipient of each 10 USDC transfer',
    })
    .option('submit', {
      type: 'boolean',
      default: false,
      describe: 'Publish the standing curve and execute all four transfers',
    })
    .option('confirm-source-router', {
      type: 'string',
      describe: 'Required with --submit; exact discovered BSC USDT router',
    })
    .option('confirm-target-router', {
      type: 'string',
      describe: 'Required with --submit; exact discovered Arbitrum USDC router',
    })
    .option('yes', {
      alias: 'y',
      type: 'boolean',
      default: false,
      describe: 'Skip the final interactive confirmation',
    })
    .strict()
    .parseAsync();

  assert(ethers.utils.isAddress(args.recipient), '--recipient must be EVM');
  const recipient = addressToBytes32(args.recipient);
  const config = parsePiecewisePublisherConfig(
    parseYaml(await readFile(args.config, 'utf8')),
  );
  const lane = selectPublisherLanes(
    config,
    [STAGING_LIFECYCLE_LANE_ID],
    'standing',
  )[0];
  const registry = args.registry
    ? getMergedRegistry({ registryUris: [args.registry], enableProxy: true })
    : getRegistry();
  const multiProvider = new MultiProvider(await registry.getMetadata());
  const slot = await discoverPiecewiseLane(
    registry as unknown as LaneRegistry,
    new EvmLaneOnchainReader(multiProvider),
    lane,
  );
  assertStagingLifecycleLane(slot);
  const standingUpdate = prepareLaneUpdate(lane, slot, 'standing');
  const fallbackUpdate = prepareLaneUpdate(lane, slot, 'fallback');
  assert(standingUpdate.mode === 'standing', 'standing update expected');
  assert(fallbackUpdate.mode === 'fallback', 'fallback update expected');

  const provider = multiProvider.getProvider(slot.origin);
  const readRouter = CrossCollateralRouter__factory.connect(
    slot.sourceRouter,
    provider,
  );
  const fee = OffchainQuotedPiecewiseLinearFee__factory.connect(
    slot.piecewiseFeeAddress,
    provider,
  );
  const token = IERC20__factory.connect(slot.feeToken, provider);
  assert(
    (await readRouter.token()).toLowerCase() === slot.feeToken.toLowerCase(),
    `Source router token does not match fee token ${slot.feeToken}`,
  );

  const rawQuote: RawLifecycleQuote = {
    destination: slot.destDomain,
    recipient,
    targetRouter: addressToBytes32(slot.targetRouter),
  };

  const quote = async (): Promise<LifecycleQuote> => {
    const [quotes, feeRootBalance] = await Promise.all([
      readRouter.quoteTransferRemoteTo(
        rawQuote.destination,
        rawQuote.recipient,
        STAGING_TRANSFER_AMOUNT,
        rawQuote.targetRouter,
      ),
      token.balanceOf(slot.routingFeeAddress),
    ]);
    assert(quotes.length === 3, 'Expected exactly three router quotes');
    const gas = quotes[0];
    const transfer = quotes[1];
    const external = quotes[2];
    assert(
      transfer.token.toLowerCase() === slot.feeToken.toLowerCase() &&
        external.token.toLowerCase() === slot.feeToken.toLowerCase(),
      'Transfer and external fees must be denominated in BSC USDT',
    );
    const gasInToken = gas.token.toLowerCase() === slot.feeToken.toLowerCase();
    const gasInNative = gas.token === constants.AddressZero;
    assert(
      gasInToken || gasInNative,
      `Unsupported gas quote token ${gas.token}`,
    );
    const transferDebit = BigInt(transfer.amount.toString());
    assert(
      transferDebit >= STAGING_TRANSFER_AMOUNT,
      'Transfer quote is smaller than principal',
    );
    return {
      piecewiseFee: transferDebit - STAGING_TRANSFER_AMOUNT,
      feeRootBalance: BigInt(feeRootBalance.toString()),
      tokenDebit:
        transferDebit +
        BigInt(external.amount.toString()) +
        (gasInToken ? BigInt(gas.amount.toString()) : 0n),
      nativeValue: gasInNative ? BigInt(gas.amount.toString()) : 0n,
      raw: rawQuote,
    };
  };

  let submitter: Wallet | undefined;
  let quoteSignerKey: string | undefined;
  let cumulativeTokenSpend = 0n;
  const dependencies = {
    getBlockTimestamp: () =>
      getLatestBlockTimestamp(multiProvider, slot.origin),
    getStandingTiming: async () =>
      toStandingTiming(await fee.getCurve(slot.destDomain, WILDCARD_RECIPIENT)),
    verifyFallback: async () => {
      const stored = await fee.getFallbackCurve();
      assert(
        valuesEqual(stored.breakpoints, fallbackUpdate.curve.breakpoints) &&
          valuesEqual(
            stored.marginalBpsX1e4,
            fallbackUpdate.curve.marginalBpsX1e4,
          ),
        'Onchain fallback curve does not match the checked-in staging fallback',
      );
    },
    quote,
    waitUntilBlockTimestamp: (target: number) =>
      pollForBlockTimestamp({
        target,
        readTimestamp: () =>
          getLatestBlockTimestamp(multiProvider, slot.origin),
        sleep: (milliseconds) =>
          new Promise((resolve) => setTimeout(resolve, milliseconds)),
      }),
    beginTransfers: async () => {
      assert(submitter, 'Submitter is unavailable');
      const connected = token.connect(submitter.connect(provider));
      const allowance = await connected.allowance(
        submitter.address,
        slot.sourceRouter,
      );
      if (!allowance.isZero()) {
        await (
          await connected.approve(
            slot.sourceRouter,
            0,
            multiProvider.getTransactionOverrides(slot.origin),
          )
        ).wait(1);
      }
      await (
        await connected.approve(
          slot.sourceRouter,
          STAGING_TOKEN_ALLOWANCE_CAP,
          multiProvider.getTransactionOverrides(slot.origin),
        )
      ).wait(1);
      assert(
        (await connected.allowance(submitter.address, slot.sourceRouter)).eq(
          STAGING_TOKEN_ALLOWANCE_CAP,
        ),
        'Failed to install exact 50e18 lifecycle allowance cap',
      );
    },
    publishStanding: async (): Promise<StandingTiming> => {
      assert(submitter, 'Submitter is unavailable');
      assert(quoteSignerKey, 'Quote signer is unavailable');
      const result = await submitPreparedUpdate(
        multiProvider,
        quoteSignerKey,
        submitter,
        standingUpdate,
      );
      console.log(
        result.status === 'submitted'
          ? `standing: ${result.txHash} confirmed`
          : 'standing: already installed',
      );
      return toStandingTiming(
        await fee.getCurve(slot.destDomain, WILDCARD_RECIPIENT),
      );
    },
    transfer: async (phase: LifecyclePhase, phaseQuote: LifecycleQuote) => {
      assert(submitter, 'Submitter is unavailable');
      const nextSpend = cumulativeTokenSpend + phaseQuote.tokenDebit;
      assert(
        nextSpend <= STAGING_TOKEN_ALLOWANCE_CAP,
        `${phase} would exceed the cumulative 50e18 token spend cap`,
      );
      const connectedToken = token.connect(submitter.connect(provider));
      const [tokenBalanceBefore, nativeBalance, allowance] = await Promise.all([
        connectedToken.balanceOf(submitter.address),
        provider.getBalance(submitter.address),
        connectedToken.allowance(submitter.address, slot.sourceRouter),
      ]);
      assert(
        BigInt(tokenBalanceBefore.toString()) >= phaseQuote.tokenDebit,
        `Insufficient BSC USDT for ${phase}`,
      );
      assert(
        BigInt(nativeBalance.toString()) >= phaseQuote.nativeValue,
        `Insufficient BSC native balance for ${phase}`,
      );
      assert(
        BigInt(allowance.toString()) >= phaseQuote.tokenDebit,
        `Lifecycle allowance exhausted before ${phase}`,
      );

      const connectedRouter = readRouter.connect(submitter.connect(provider));
      const raw = phaseQuote.raw as RawLifecycleQuote;
      const tx = await connectedRouter.transferRemoteTo(
        raw.destination,
        raw.recipient,
        STAGING_TRANSFER_AMOUNT,
        raw.targetRouter,
        {
          ...multiProvider.getTransactionOverrides(slot.origin),
          value: phaseQuote.nativeValue,
        },
      );
      const receipt = await tx.wait(1);
      assert(receipt.status === 1, `${phase} transfer reverted`);
      const [feeRootBalance, tokenBalanceAfter, block] = await Promise.all([
        token.balanceOf(slot.routingFeeAddress),
        token.balanceOf(submitter.address),
        provider.getBlock(receipt.blockNumber),
      ]);
      assert(block, `Missing BSC block ${receipt.blockNumber}`);
      const actualTokenSpend =
        BigInt(tokenBalanceBefore.toString()) -
        BigInt(tokenBalanceAfter.toString());
      assert(
        actualTokenSpend === phaseQuote.tokenDebit,
        `${phase} actual token spend ${actualTokenSpend} != quoted ${phaseQuote.tokenDebit}`,
      );
      cumulativeTokenSpend += actualTokenSpend;
      return {
        txHash: tx.hash,
        feeRootBalance: BigInt(feeRootBalance.toString()),
        blockTimestamp: block.timestamp,
      };
    },
    endTransfers: async () => {
      assert(submitter, 'Submitter is unavailable');
      const connected = token.connect(submitter.connect(provider));
      if (
        !(
          await connected.allowance(submitter.address, slot.sourceRouter)
        ).isZero()
      ) {
        await (
          await connected.approve(
            slot.sourceRouter,
            0,
            multiProvider.getTransactionOverrides(slot.origin),
          )
        ).wait(1);
      }
      assert(
        (
          await connected.allowance(submitter.address, slot.sourceRouter)
        ).isZero(),
        'Lifecycle allowance revoke failed',
      );
    },
  };

  if (!args.submit) {
    await runStagingLifecycle({
      submit: false,
      slot,
      fallbackCurve: fallbackUpdate.curve,
      standingCurve: standingUpdate.curve,
      dependencies,
      log: console.log,
    });
    return;
  }

  assertExactRouterConfirmations(
    slot,
    args.confirmSourceRouter,
    args.confirmTargetRouter,
  );
  if (!args.yes) {
    const approved = await confirm({
      message:
        `Publish one standing curve and send four 10 USDT transfers from ${slot.sourceRouter}` +
        ` to explicit target ${slot.targetRouter}, recipient ${args.recipient}?`,
      default: false,
    });
    if (!approved) return;
  }

  const [signerSecret, deployerSecret] = await Promise.all([
    resolveGcpKey(GCP_SIGNER_SECRET),
    resolveGcpKey(GCP_DEPLOYER_SECRET),
  ]);
  submitter = new Wallet(deployerSecret.privateKey);
  quoteSignerKey = signerSecret.privateKey;
  await verifyPiecewiseSignerAuthorization(multiProvider, quoteSignerKey, [
    standingUpdate,
  ]);
  await runStagingLifecycle({
    submit: true,
    slot,
    fallbackCurve: fallbackUpdate.curve,
    standingCurve: standingUpdate.curve,
    dependencies,
    log: console.log,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
