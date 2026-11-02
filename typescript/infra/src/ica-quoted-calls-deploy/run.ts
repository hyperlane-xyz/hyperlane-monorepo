import { BigNumber, constants, providers, utils } from 'ethers';

import {
  CONTRACTS_PACKAGE_VERSION,
  InterchainAccountRouter__factory,
  QuotedCalls__factory,
} from '@hyperlane-xyz/core';
import {
  ChainName,
  ChainTechnicalStack,
  ContractVerificationInput,
  PERMIT2_ADDRESS,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  assert,
  concurrentMap,
  eqAddress,
} from '@hyperlane-xyz/utils';

import { DEFAULT_OFFCHAIN_LOOKUP_ISM_URLS } from '../../config/environments/utils.js';
import { verifyDeployed } from '../aggregation-hook-upgrade/execute.js';
import { isStandardEvm } from '../aggregation-hook-upgrade/protocol.js';
import {
  RegistryAddressUpdate,
  buildRegistryAddresses,
} from '../aggregation-hook-upgrade/registry.js';

import {
  DeployHooks,
  afterDeploy,
  deployQuotedCalls,
  deployRouter,
  sendApproval,
  sendEnrollments,
  sendSetHook,
  sendTransferOwnership,
} from './execute.js';
import type { IcaChainExportUpdate, RegistryBefore } from './export.js';
import {
  PeerRouter,
  RouterWiringState,
  assessFunds,
  effectiveFees,
  estimateWiringSteps,
  isPairVersion,
  planWiring,
  selectQuotedCalls,
  selectRouter,
} from './plan.js';
import {
  PendingState,
  candidateAddresses,
  noAllowances,
  readAllowances,
  readPendingState,
  readQuotedCallsCandidates,
  readRemoteRouters,
  readRouterCandidates,
  splitPricedTokens,
  validateShadowHook,
} from './read.js';
import { IcaChainReader, createIcaChainReader } from './reader.js';
import { describeIcaError } from './signer.js';
import {
  Adoption,
  COMMIT_TX_GAS_USAGE,
  ChainResult,
  ContractKind,
  GasStep,
  IcaContext,
  IcaOutcome,
  PeerDomain,
  ShadowHook,
  SkipReason,
  TokenAllowance,
} from './types.js';

export interface PreparedChain {
  result: ChainResult;
  verificationInputs: ContractVerificationInput[];
  // Set once the chain has been read; absent for skipped and failed chains.
  wiring?: {
    reader: IcaChainReader;
    signer: Address;
    owner: Address;
    peers: PeerDomain[];
    routerAddress?: Address;
    routerState: RouterWiringState;
    allowances: TokenAllowance[];
    shadow?: ShadowHook;
    igp?: Address;
    pricedTokens: TokenAllowance['token'][];
    registryBefore: RegistryBefore;
  };
}

function newResult(chain: ChainName): ChainResult {
  return {
    chain,
    outcome: IcaOutcome.UpToDate,
    rejected: [],
    enrolledPeers: [],
    approved: [],
    registryKeysWritten: [],
    pending: [],
    notes: [],
    problems: [],
  };
}

type ExportFields = Partial<
  Pick<
    IcaChainExportUpdate,
    | 'router'
    | 'quotedCalls'
    | 'hook'
    | 'approvals'
    | 'enrolledPeers'
    | 'pending'
    | 'clearPending'
  >
>;

function exportUpdate(
  wiring: NonNullable<PreparedChain['wiring']>,
  fields: ExportFields,
): IcaChainExportUpdate {
  return {
    signer: wiring.signer,
    owner: wiring.owner,
    registryBefore: wiring.registryBefore,
    router: fields.router,
    quotedCalls: fields.quotedCalls,
    hook: fields.hook,
    approvals: fields.approvals,
    enrolledPeers: fields.enrolledPeers,
    pending: fields.pending,
    clearPending: fields.clearPending,
  };
}

function deployData(transaction: providers.TransactionRequest): string {
  assert(transaction.data !== undefined, 'The deploy transaction has no data');
  return utils.hexlify(transaction.data);
}

// Reads the chain, decides which of the pair has to be deployed and checks the
// signer can pay for everything this chain needs before any transaction exists.
async function prepareChain(
  ctx: IcaContext,
  chain: ChainName,
): Promise<PreparedChain> {
  const { multiProvider, logger } = ctx;
  const result = newResult(chain);
  const verificationInputs: ContractVerificationInput[] = [];
  const metadata = multiProvider.getChainMetadata(chain);
  if (!isStandardEvm(metadata.protocol)) {
    result.outcome = IcaOutcome.Skipped;
    result.skipReason = SkipReason.NotStandardEvm;
    result.detail = `${chain} uses protocol ${metadata.protocol}`;
    return { result, verificationInputs };
  }
  const addresses = ctx.chainAddresses[chain];
  const mailbox = addresses?.mailbox;
  if (mailbox === undefined) {
    result.outcome = IcaOutcome.Skipped;
    result.skipReason = SkipReason.NoMailbox;
    result.detail = `no mailbox for ${chain} in the registry`;
    return { result, verificationInputs };
  }

  const signer = ctx.apply
    ? await multiProvider.getSignerAddress(chain)
    : ctx.planningSigner;
  const owner = ctx.owner ?? signer;
  result.signer = signer;
  result.owner = owner;
  result.gasSymbol = metadata.nativeToken?.symbol ?? 'native';
  if (!eqAddress(owner, signer)) {
    result.notes.push(
      `the router's commitment ISM (CCIP_READ_ISM) stays owned by ${signer}; only the router is handed to ${owner}`,
    );
  }

  const reader = createIcaChainReader(multiProvider.getProvider(chain), {
    opStack: metadata.technicalStack === ChainTechnicalStack.OpStack,
    logger,
  });
  const peers: PeerDomain[] = ctx.chains
    .filter((other) => other !== chain)
    .map((other) => ({
      chain: other,
      domainId: multiProvider.getDomainId(other),
    }));
  const registryBefore: RegistryBefore = {};
  if (addresses?.interchainAccountRouterV3 !== undefined) {
    registryBefore.interchainAccountRouterV3 =
      addresses.interchainAccountRouterV3;
  }
  if (addresses?.quotedCallsV3 !== undefined) {
    registryBefore.quotedCallsV3 = addresses.quotedCallsV3;
  }
  const recorded = await ctx.persist.exportStore.read(chain);

  // A deploy sent by an earlier run may not have been confirmed yet. Deploying
  // again before it is known to have failed could leave two copies behind.
  const abandoned: ContractKind[] = [];
  const resolvePending = async (
    contract: ContractKind,
  ): Promise<Address | undefined> => {
    const entry = recorded?.pending.find(
      (known) => known.contract === contract,
    );
    if (entry === undefined) return undefined;
    const state = await readPendingState(reader, entry);
    if (state === PendingState.Deployed) return entry.address;
    if (state === PendingState.Unmined) {
      result.problems.push(
        `the ${contract} deploy to ${entry.address} (nonce ${entry.nonce} of ${entry.signer}) is not mined yet: wait for it, or remove its pending entry from the export if it was never sent`,
      );
    } else {
      result.notes.push(
        `the ${contract} deploy to ${entry.address} never happened: nonce ${entry.nonce} of ${entry.signer} was used by another transaction`,
      );
      abandoned.push(contract);
    }
    return undefined;
  };
  const pendingRouter = await resolvePending(ContractKind.Router);
  const pendingQuotedCalls = await resolvePending(ContractKind.QuotedCalls);
  if (result.problems.length > 0) {
    result.outcome = IcaOutcome.Error;
    result.detail = result.problems.join('; ');
    return { result, verificationInputs };
  }

  const routerCandidates = await readRouterCandidates(
    reader,
    candidateAddresses(
      addresses?.interchainAccountRouterV3,
      recorded?.router?.address,
      pendingRouter,
    ),
  );
  const quotedCallsCandidates = await readQuotedCallsCandidates(
    reader,
    candidateAddresses(
      addresses?.quotedCallsV3,
      recorded?.quotedCalls?.address,
      pendingQuotedCalls,
    ),
  );
  for (const missing of [
    ...routerCandidates.missingCode,
    ...quotedCallsCandidates.missingCode,
  ]) {
    result.rejected.push({
      address: missing.address,
      source: missing.source,
      reason: 'has no code',
    });
  }
  const routerSelection = selectRouter(routerCandidates.found, {
    mailbox,
    signer,
    owner,
  });
  const quotedCallsSelection = selectQuotedCalls(quotedCallsCandidates.found);
  result.rejected.push(
    ...(routerSelection.kind === Adoption.Deploy
      ? routerSelection.rejected
      : []),
    ...(quotedCallsSelection.kind === Adoption.Deploy
      ? quotedCallsSelection.rejected
      : []),
  );
  result.router =
    routerSelection.kind === Adoption.Adopt
      ? {
          address: routerSelection.candidate.address,
          action: Adoption.Adopt,
          version: routerSelection.candidate.version,
        }
      : { action: Adoption.Deploy };
  result.quotedCalls =
    quotedCallsSelection.kind === Adoption.Adopt
      ? {
          address: quotedCallsSelection.candidate.address,
          action: Adoption.Adopt,
          version: quotedCallsSelection.candidate.version,
        }
      : { action: Adoption.Deploy };

  const igp = addresses?.interchainGasPaymaster;
  const tokens = ctx.feeTokens[chain] ?? [];
  let priced: TokenAllowance['token'][] = [];
  if (tokens.length === 0) {
    result.notes.push(
      'no ERC20 fee tokens configured: only native fees work from this chain',
    );
  } else if (igp === undefined) {
    result.notes.push(
      'no interchainGasPaymaster in the registry: no fee token approvals',
    );
  } else {
    const split = await splitPricedTokens(reader, { igp, tokens, peers });
    priced = split.priced;
    for (const token of split.unpriced) {
      result.notes.push(
        `${token.symbol} has no gas oracle on ${chain}: not approved`,
      );
    }
  }

  const shadowAddress = await ctx.readShadowHook(chain);
  const shadow =
    shadowAddress === undefined
      ? undefined
      : await validateShadowHook(reader, shadowAddress, mailbox);

  let routerState: RouterWiringState;
  let allowances: TokenAllowance[];
  let routerAddress: Address | undefined;
  if (routerSelection.kind === Adoption.Adopt) {
    const adopted = routerSelection.candidate;
    routerAddress = adopted.address;
    routerState = {
      owner: adopted.owner,
      hook: adopted.hook,
      remoteRouters: await readRemoteRouters(reader, adopted.address, peers),
    };
    allowances =
      igp === undefined
        ? []
        : await readAllowances(reader, {
            router: adopted.address,
            igp,
            tokens: priced,
          });
  } else {
    routerState = {
      owner: signer,
      hook: constants.AddressZero,
      remoteRouters: new Map(),
    };
    allowances = igp === undefined ? [] : noAllowances(igp, priced);
  }

  const steps: GasStep[] = [];
  let l1FeeUnavailable = false;
  const deploySteps = async (name: string, data: string) => {
    const [gas, l1Fee] = await Promise.all([
      reader.estimateDeployGas(signer, data),
      reader.l1DataFee(data),
    ]);
    if (
      metadata.technicalStack === ChainTechnicalStack.OpStack &&
      l1Fee === undefined
    ) {
      l1FeeUnavailable = true;
    }
    steps.push({ name, gas, l1Fee: l1Fee ?? BigNumber.from(0) });
  };
  if (routerSelection.kind === Adoption.Deploy) {
    await deploySteps(
      'deploy InterchainAccountRouter',
      deployData(
        new InterchainAccountRouter__factory().getDeployTransaction(
          mailbox,
          constants.AddressZero,
          signer,
          COMMIT_TX_GAS_USAGE,
          DEFAULT_OFFCHAIN_LOOKUP_ISM_URLS,
        ),
      ),
    );
  }
  if (quotedCallsSelection.kind === Adoption.Deploy) {
    await deploySteps(
      'deploy QuotedCalls',
      deployData(
        new QuotedCalls__factory().getDeployTransaction(PERMIT2_ADDRESS),
      ),
    );
  }
  steps.push(
    ...estimateWiringSteps({
      state: routerState,
      signer,
      owner,
      shadowHook: shadow,
      allowances,
      peers,
    }),
  );

  if (steps.length > 0) {
    const fees = effectiveFees(
      await reader.fees(),
      multiProvider.getTransactionOverrides(chain),
    );
    result.funds = assessFunds({
      balance: await reader.balance(signer),
      steps,
      fees,
      l1FeeUnavailable,
    });
    if (result.funds.shortfall.gt(0)) {
      result.outcome = IcaOutcome.InsufficientFunds;
      result.detail = `${signer} needs ${utils.formatEther(result.funds.shortfall)} more ${result.gasSymbol}`;
    }
  }

  const wiring: NonNullable<PreparedChain['wiring']> = {
    reader,
    signer,
    owner,
    peers,
    routerAddress,
    routerState,
    allowances,
    shadow,
    igp,
    pricedTokens: priced,
    registryBefore,
  };
  const prepared: PreparedChain = { result, verificationInputs, wiring };
  if (ctx.apply && result.outcome !== IcaOutcome.InsufficientFunds) {
    for (const contract of abandoned) {
      await ctx.persist.exportStore.update(
        chain,
        exportUpdate(wiring, { clearPending: contract }),
        ctx.now(),
      );
    }
    await deployPair(ctx, {
      chain,
      mailbox,
      reader,
      prepared,
      routerKind: routerSelection.kind,
      quotedCallsKind: quotedCallsSelection.kind,
    });
  }
  return prepared;
}

async function persistInputs(
  ctx: IcaContext,
  prepared: PreparedChain,
  inputs: ContractVerificationInput[],
): Promise<void> {
  const { result } = prepared;
  prepared.verificationInputs.push(...inputs);
  try {
    await ctx.persist.writeVerificationInputs(result.chain, inputs);
  } catch (error: unknown) {
    const detail = describeIcaError(error, ctx.redact);
    ctx.logger.error(
      `[${result.chain}] failed to persist verification inputs: ${detail}`,
    );
    result.problems.push(`verification inputs were not persisted: ${detail}`);
  }
}

// Each deployed address is recorded before anything else is done with it, so
// a failure after the transaction mined never loses the only handle to it.
async function deployPair(
  ctx: IcaContext,
  args: {
    chain: ChainName;
    mailbox: Address;
    reader: IcaChainReader;
    prepared: PreparedChain;
    routerKind: Adoption;
    quotedCallsKind: Adoption;
  },
): Promise<void> {
  const { chain, mailbox, reader, prepared } = args;
  const { result, wiring } = prepared;
  assert(wiring, `Chain ${chain} was not read`);
  const { signer } = wiring;
  const { multiProvider, persist, logger } = ctx;

  const hooks = (contract: ContractKind): DeployHooks => ({
    onPending: (pending) =>
      persist.exportStore.update(
        chain,
        exportUpdate(wiring, {
          pending: {
            contract,
            address: pending.address,
            signer: pending.signer,
            nonce: pending.nonce,
          },
        }),
        ctx.now(),
      ),
    onNotSent: () =>
      persist.exportStore.update(
        chain,
        exportUpdate(wiring, { clearPending: contract }),
        ctx.now(),
      ),
  });

  if (args.routerKind === Adoption.Adopt) {
    assert(
      result.router?.address && result.router.version,
      `No router to adopt on ${chain}`,
    );
    await persist.exportStore.update(
      chain,
      exportUpdate(wiring, {
        router: {
          address: result.router.address,
          version: result.router.version,
        },
      }),
      ctx.now(),
    );
  } else {
    const deployed = await deployRouter({
      multiProvider,
      chain,
      mailbox,
      owner: signer,
      hooks: hooks(ContractKind.Router),
    });
    logger.info(`[${chain}] deployed router at ${deployed.address}`);
    await afterDeploy(
      'Router',
      chain,
      deployed.address,
      async () => {
        await persist.exportStore.update(
          chain,
          exportUpdate(wiring, {
            router: {
              address: deployed.address,
              version: CONTRACTS_PACKAGE_VERSION,
              deployTxHash: deployed.deployTxHash,
            },
          }),
          ctx.now(),
        );
        await persistInputs(ctx, prepared, [deployed.verificationInput]);
        assert(
          eqAddress(deployed.address, deployed.predictedAddress),
          `Router ${deployed.address} on ${chain} is not at the predicted address ${deployed.predictedAddress}`,
        );
        const [version, state] = await Promise.all([
          reader.packageVersion(deployed.address),
          reader.routerState(deployed.address),
        ]);
        assert(
          isPairVersion(version),
          `Deployed router ${deployed.address} on ${chain} reports version ${version}`,
        );
        assert(
          eqAddress(state.owner, signer),
          `Deployed router ${deployed.address} on ${chain} is owned by ${state.owner}, not ${signer}`,
        );
        wiring.routerAddress = deployed.address;
        result.router = {
          address: deployed.address,
          action: Adoption.Deploy,
          version,
          deployed: true,
        };
      },
      ctx.redact,
    );
  }

  if (args.quotedCallsKind === Adoption.Adopt) {
    assert(
      result.quotedCalls?.address && result.quotedCalls.version,
      `No QuotedCalls to adopt on ${chain}`,
    );
    await persist.exportStore.update(
      chain,
      exportUpdate(wiring, {
        quotedCalls: {
          address: result.quotedCalls.address,
          version: result.quotedCalls.version,
          permit2: PERMIT2_ADDRESS,
        },
      }),
      ctx.now(),
    );
  } else {
    const deployed = await deployQuotedCalls({
      multiProvider,
      chain,
      hooks: hooks(ContractKind.QuotedCalls),
    });
    logger.info(`[${chain}] deployed QuotedCalls at ${deployed.address}`);
    await afterDeploy(
      'QuotedCalls',
      chain,
      deployed.address,
      async () => {
        await persist.exportStore.update(
          chain,
          exportUpdate(wiring, {
            quotedCalls: {
              address: deployed.address,
              version: CONTRACTS_PACKAGE_VERSION,
              permit2: PERMIT2_ADDRESS,
              deployTxHash: deployed.deployTxHash,
            },
          }),
          ctx.now(),
        );
        await persistInputs(ctx, prepared, [deployed.verificationInput]);
        assert(
          eqAddress(deployed.address, deployed.predictedAddress),
          `QuotedCalls ${deployed.address} on ${chain} is not at the predicted address ${deployed.predictedAddress}`,
        );
        const [version, permit2] = await Promise.all([
          reader.packageVersion(deployed.address),
          reader.quotedCallsPermit2(deployed.address),
        ]);
        assert(
          isPairVersion(version),
          `Deployed QuotedCalls ${deployed.address} on ${chain} reports version ${version}`,
        );
        assert(
          eqAddress(permit2, PERMIT2_ADDRESS),
          `Deployed QuotedCalls ${deployed.address} on ${chain} uses Permit2 ${permit2}`,
        );
        result.quotedCalls = {
          address: deployed.address,
          action: Adoption.Deploy,
          version,
          deployed: true,
        };
      },
      ctx.redact,
    );
  }
}

function summarize(
  prepared: PreparedChain,
  plan: ReturnType<typeof planWiring>,
) {
  const { result } = prepared;
  result.wiring = plan;
  if (result.router?.action === Adoption.Deploy && !result.router.deployed) {
    result.pending.push('deploy an InterchainAccountRouter');
  }
  if (
    result.quotedCalls?.action === Adoption.Deploy &&
    !result.quotedCalls.deployed
  ) {
    result.pending.push('deploy QuotedCalls');
  }
  if (plan.setHook !== undefined) {
    result.pending.push(`set the hook to ${plan.setHook}`);
  }
  for (const { token, spender } of plan.approvals) {
    result.pending.push(`approve ${token.symbol} for ${spender}`);
  }
  if (plan.enroll.length > 0) {
    result.pending.push(
      `enroll ${plan.enroll.map(({ peer }) => peer.chain).join(', ')}`,
    );
  }
  if (plan.awaiting.length > 0) {
    result.pending.push(
      `enroll ${plan.awaiting.join(', ')} once their routers exist`,
    );
  }
  if (plan.transferOwnershipTo !== undefined) {
    result.pending.push(`transfer ownership to ${plan.transferOwnershipTo}`);
  }
  result.notes.push(...plan.notes);
  result.problems.push(...plan.conflicts);
}

async function wireChain(
  ctx: IcaContext,
  prepared: PreparedChain,
  peers: PeerRouter[],
): Promise<void> {
  const { result, wiring } = prepared;
  if (wiring === undefined) return;
  const planFor = (state: RouterWiringState, allowances: TokenAllowance[]) =>
    planWiring({
      state,
      signer: wiring.signer,
      owner: wiring.owner,
      shadowHook: wiring.shadow,
      allowances,
      peers,
    });

  let plan = planFor(wiring.routerState, wiring.allowances);
  const router = wiring.routerAddress;
  const failedFunds = result.outcome === IcaOutcome.InsufficientFunds;
  if (
    !ctx.apply ||
    failedFunds ||
    router === undefined ||
    plan.conflicts.length > 0
  ) {
    summarize(prepared, plan);
    return;
  }

  const { multiProvider, persist } = ctx;
  const { chain } = result;
  const needsOwner =
    plan.setHook !== undefined ||
    plan.approvals.length > 0 ||
    plan.enroll.length > 0;
  assert(
    !needsOwner || eqAddress(wiring.routerState.owner, wiring.signer),
    `Signer ${wiring.signer} is not the owner ${wiring.routerState.owner} of router ${router} on ${chain}`,
  );

  if (plan.setHook !== undefined) {
    await sendSetHook({ multiProvider, chain, router, hook: plan.setHook });
    await persist.exportStore.update(
      chain,
      exportUpdate(wiring, { hook: plan.setHook }),
      ctx.now(),
    );
    result.hook = plan.setHook;
  }
  for (const { token, spender } of plan.approvals) {
    await sendApproval({
      multiProvider,
      chain,
      router,
      feeToken: token.address,
      spender,
    });
    await persist.exportStore.update(
      chain,
      exportUpdate(wiring, {
        approvals: [{ feeToken: token.address, spender }],
      }),
      ctx.now(),
    );
    result.approved.push(token.symbol);
  }
  if (plan.enroll.length > 0) {
    await sendEnrollments({
      multiProvider,
      chain,
      router,
      enroll: plan.enroll,
    });
    const enrolled = plan.enroll.map(({ peer }) => peer.chain);
    await persist.exportStore.update(
      chain,
      exportUpdate(wiring, { enrolledPeers: enrolled }),
      ctx.now(),
    );
    result.enrolledPeers.push(...enrolled);
  }

  // The reads after the writes prove the state, and the ownership transfer is
  // only planned once nothing else is left for the signer to do.
  const state = await readRouterState(wiring.reader, router, wiring.peers);
  const allowances =
    wiring.igp === undefined
      ? []
      : await readAllowances(wiring.reader, {
          router,
          igp: wiring.igp,
          tokens: wiring.pricedTokens,
        });
  plan = planFor(state, allowances);
  const leftover = [
    ...(plan.setHook === undefined ? [] : ['the hook']),
    ...plan.approvals.map(({ token }) => `the ${token.symbol} approval`),
    ...plan.enroll.map(({ peer }) => `the ${peer.chain} enrollment`),
  ];
  if (leftover.length > 0) {
    result.problems.push(
      `${leftover.join(', ')} did not take effect on router ${router}`,
    );
  }
  if (plan.transferOwnershipTo !== undefined) {
    await sendTransferOwnership({
      multiProvider,
      chain,
      router,
      owner: plan.transferOwnershipTo,
    });
    const after = await wiring.reader.routerState(router);
    if (!eqAddress(after.owner, plan.transferOwnershipTo)) {
      result.problems.push(
        `router ${router} is owned by ${after.owner}, not ${plan.transferOwnershipTo}`,
      );
    }
    plan.transferOwnershipTo = undefined;
  }
  summarize(prepared, plan);
}

async function readRouterState(
  reader: IcaChainReader,
  router: Address,
  peers: PeerDomain[],
): Promise<RouterWiringState> {
  const [state, remoteRouters] = await Promise.all([
    reader.routerState(router),
    readRemoteRouters(reader, router, peers),
  ]);
  return { owner: state.owner, hook: state.hook, remoteRouters };
}

function didWork(result: ChainResult): boolean {
  return (
    result.router?.deployed === true ||
    result.quotedCalls?.deployed === true ||
    result.hook !== undefined ||
    result.approved.length > 0 ||
    result.enrolledPeers.length > 0
  );
}

// The registry is the source clients read the pair from, so it only moves to
// chains where the pair is deployed, wired and complete.
async function writeRegistry(
  ctx: IcaContext,
  result: ChainResult,
): Promise<void> {
  const { chain } = result;
  const current = ctx.chainAddresses[chain];
  const router = result.router?.address;
  const quotedCalls = result.quotedCalls?.address;
  const converged =
    (result.outcome === IcaOutcome.Applied ||
      result.outcome === IcaOutcome.UpToDate) &&
    result.pending.length === 0 &&
    result.problems.length === 0;
  if (
    current === undefined ||
    router === undefined ||
    quotedCalls === undefined
  ) {
    return;
  }
  if (!converged) {
    result.notes.push(
      'registry not updated: the chain is not fully deployed and wired',
    );
    return;
  }
  const update: RegistryAddressUpdate = {};
  if (
    current.interchainAccountRouterV3 === undefined ||
    !eqAddress(current.interchainAccountRouterV3, router)
  ) {
    update.interchainAccountRouterV3 = router;
  }
  if (
    current.quotedCallsV3 === undefined ||
    !eqAddress(current.quotedCallsV3, quotedCalls)
  ) {
    update.quotedCallsV3 = quotedCalls;
  }
  if (Object.keys(update).length === 0) return;
  try {
    ctx.persist.writeRegistryAddresses(
      chain,
      buildRegistryAddresses(current, update),
    );
  } catch (error: unknown) {
    result.outcome = IcaOutcome.Error;
    result.detail = `the registry was not updated: ${describeIcaError(error, ctx.redact)}`;
    return;
  }
  result.registryKeysWritten.push(...Object.keys(update));
  result.registryBefore = (
    await ctx.persist.exportStore.read(chain)
  )?.registryBefore;
}

export async function runIcaDeploy(ctx: IcaContext): Promise<ChainResult[]> {
  assert(ctx.chains.length > 0, 'No chains selected');
  const failed = (chain: ChainName, error: unknown): PreparedChain => {
    const result = newResult(chain);
    result.outcome = IcaOutcome.Error;
    result.detail = describeIcaError(error, ctx.redact);
    ctx.logger.error(`[${chain}] ${result.detail}`);
    return { result, verificationInputs: [] };
  };

  const prepared = await concurrentMap(
    ctx.concurrency,
    ctx.chains,
    async (chain): Promise<PreparedChain> => {
      try {
        return await prepareChain(ctx, chain);
      } catch (error: unknown) {
        return failed(chain, error);
      }
    },
  );

  const peerRouters = (chain: ChainName): PeerRouter[] =>
    prepared
      .filter(({ result }) => result.chain !== chain)
      .map(({ result }) => ({
        chain: result.chain,
        domainId: ctx.multiProvider.getDomainId(result.chain),
        router: result.router?.address,
      }));

  await concurrentMap(ctx.concurrency, prepared, async (entry) => {
    if (entry.result.outcome === IcaOutcome.Error) return;
    if (entry.result.skipReason !== undefined) return;
    try {
      await wireChain(ctx, entry, peerRouters(entry.result.chain));
    } catch (error: unknown) {
      const { result } = failed(entry.result.chain, error);
      entry.result.outcome = result.outcome;
      entry.result.detail = result.detail;
    }
  });

  for (const { result } of prepared) {
    if (result.outcome === IcaOutcome.Error) continue;
    if (result.skipReason !== undefined) continue;
    if (result.problems.length > 0) {
      result.outcome = IcaOutcome.Error;
      result.detail = result.problems.join('; ');
    } else if (result.outcome === IcaOutcome.InsufficientFunds) {
      continue;
    } else if (ctx.apply) {
      if (didWork(result)) result.outcome = IcaOutcome.Applied;
      else if (result.pending.length > 0) result.outcome = IcaOutcome.Planned;
      else result.outcome = IcaOutcome.UpToDate;
    } else if (result.pending.length > 0) {
      result.outcome = IcaOutcome.Planned;
    }
  }

  if (ctx.apply && ctx.writeRegistry) {
    for (const { result } of prepared) await writeRegistry(ctx, result);
  }

  if (ctx.apply) {
    for (const { result, verificationInputs } of prepared) {
      await verifyDeployed({
        chain: result.chain,
        contractVerifier: ctx.contractVerifier,
        inputs: verificationInputs,
        logger: ctx.logger,
      });
    }
  }
  return prepared.map(({ result }) => result);
}
