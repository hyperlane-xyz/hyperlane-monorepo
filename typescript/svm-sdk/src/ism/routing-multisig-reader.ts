import { address as parseAddress, type Address } from '@solana/kit';

import {
  type ArtifactDeployed,
  ArtifactComposition,
  type ArtifactReader,
  ArtifactState,
  type ConfigOnChain,
  type WithCompositionVariant,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type { RoutingIsmArtifactConfig } from '@hyperlane-xyz/provider-sdk/ism';
import { assert, rootLogger, ZERO_ADDRESS_HEX_32 } from '@hyperlane-xyz/utils';

import {
  decodeMultisigIsmAccessControlAccount,
  decodeMultisigIsmDomainDataAccount,
  type AccessControlData,
  type DomainData,
} from '../accounts/multisig-ism-message-id.js';
import {
  deriveMultisigIsmAccessControlPda,
  deriveMultisigIsmDomainDataPda,
} from '../pda.js';
import type { SvmDeployedIsm, SvmRpc } from '../types.js';

import { validatorBytesToHex } from './ism-query.js';

/**
 * Pre-deploy shape (children are `ArtifactEmbedded`).
 */
type EmbeddedRoutingMultisigConfig = WithCompositionVariant<
  RoutingIsmArtifactConfig,
  typeof ArtifactComposition.EMBEDDED
>;

/**
 * Post-deploy on-chain shape: EMBEDDED children collapse to `ArtifactDeployed`
 * via `ConfigOnChain`. This is what `read()` returns per the embedded
 * `ArtifactReader` contract.
 */
type EmbeddedRoutingMultisigOnChain = ConfigOnChain<
  EmbeddedRoutingMultisigConfig,
  SvmDeployedIsm
>;

type EmbeddedDomainChild = EmbeddedRoutingMultisigOnChain['domains'][number];

/**
 * Raw account input shape accepted by the pure decoder. Mirrors the relevant
 * subset of `getProgramAccounts` results: `pubkey` plus base64-encoded data.
 */
export interface RoutingMultisigAccount {
  pubkey: Address;
  data: Uint8Array;
}

/**
 * Reader for the SVM "routing multisig" embedded artifact.
 *
 * Per the on-chain layout (rust/sealevel multisig-ism-message-id), DomainData
 * accounts store `{ bump, validators_and_threshold }` only — the domain id is
 * part of the PDA seed, not the payload. As a result this reader cannot
 * enumerate on-chain domains without external candidates. Callers driving an
 * update or diff flow read per-domain via `deriveMultisigIsmDomainDataPda` +
 * the expected config's domain set. Pass `candidateDomains` to surface a
 * specific set in `read()` results.
 */
export class SvmRoutingMultisigReader implements ArtifactReader<
  RoutingIsmArtifactConfig,
  SvmDeployedIsm,
  typeof ArtifactComposition.EMBEDDED
> {
  readonly composition = ArtifactComposition.EMBEDDED;

  private readonly logger = rootLogger.child({
    module: 'SvmRoutingMultisigReader',
  });

  constructor(
    protected readonly rpc: SvmRpc,
    protected readonly candidateDomains: readonly number[] = [],
  ) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<EmbeddedRoutingMultisigOnChain, SvmDeployedIsm>> {
    const programId = parseAddress(address);
    const accounts = await fetchRoutingMultisigAccounts(this.rpc, programId);
    const { accessControl, domains, unmatchedDomainAccounts } =
      await decodeRoutingMultisigAccounts(
        programId,
        accounts,
        this.candidateDomains,
      );

    if (unmatchedDomainAccounts.length > 0) {
      this.logger.warn(
        `Routing multisig at ${programId}: ${unmatchedDomainAccounts.length} on-chain domain account(s) did not match any candidate domain; pass them via candidateDomains to surface in the read result`,
        { programId, unmatchedDomainAccounts },
      );
    }

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        composition: ArtifactComposition.EMBEDDED,
        type: 'domainRoutingIsm',
        owner: accessControl.owner ?? ZERO_ADDRESS_HEX_32,
        domains,
      },
      deployed: { address: programId, programId },
    };
  }
}

/**
 * Fetch every account owned by `programId` and shape into the pure-decoder
 * input. Exposed for callers (e.g. the colocated writer's `update()`) that
 * need to enumerate live domains via the same RPC call.
 */
export async function fetchRoutingMultisigAccounts(
  rpc: SvmRpc,
  programId: Address,
): Promise<RoutingMultisigAccount[]> {
  const allAccounts = await rpc
    .getProgramAccounts(programId, { encoding: 'base64' })
    .send();
  return allAccounts.map((entry) => ({
    pubkey: entry.pubkey,
    data: Uint8Array.from(Buffer.from(entry.account.data[0], 'base64')),
  }));
}

/**
 * Pure helper: given a program id, a list of raw accounts owned by it, and
 * a set of candidate domains, decode the embedded routing-multisig artifact.
 * Exposed for unit testing the decode logic without an RPC.
 *
 * The access-control PDA is identified by deriving its known seed; all other
 * accounts are decoded as DomainData and matched against `candidateDomains`
 * by re-deriving each candidate's PDA. Accounts that match no candidate are
 * left out of the returned `domains` map.
 */
export async function decodeRoutingMultisigAccounts(
  programId: Address,
  accounts: readonly RoutingMultisigAccount[],
  candidateDomains: readonly number[],
): Promise<{
  accessControl: AccessControlData;
  domains: Record<number, EmbeddedDomainChild>;
  unmatchedDomainAccounts: Address[];
}> {
  const { address: accessControlPda } =
    await deriveMultisigIsmAccessControlPda(programId);

  const accessAccount = accounts.find((a) => a.pubkey === accessControlPda);
  assert(
    accessAccount !== undefined,
    `Routing multisig at ${programId} is not initialized (access-control PDA missing)`,
  );
  const accessControl = decodeMultisigIsmAccessControlAccount(
    accessAccount.data,
  );
  assert(
    accessControl !== null,
    `Routing multisig at ${programId} access-control account is uninitialized`,
  );

  const domains = await resolveDomainAccounts(
    programId,
    accounts.filter((a) => a.pubkey !== accessControlPda),
    candidateDomains,
  );

  const matchedAddresses = new Set(
    Object.values(domains).map((d) => d.deployed.address),
  );
  const unmatchedDomainAccounts = accounts
    .filter(
      (a) => a.pubkey !== accessControlPda && !matchedAddresses.has(a.pubkey),
    )
    .map((a) => a.pubkey);

  return { accessControl, domains, unmatchedDomainAccounts };
}

async function resolveDomainAccounts(
  programId: Address,
  domainAccounts: readonly RoutingMultisigAccount[],
  candidateDomains: readonly number[],
): Promise<Record<number, EmbeddedDomainChild>> {
  const pdaPairs = await Promise.all(
    candidateDomains.map(async (domain) => {
      const { address } = await deriveMultisigIsmDomainDataPda(
        programId,
        domain,
      );
      return [address, domain] as const;
    }),
  );
  const addressToDomain = new Map<Address, number>(pdaPairs);

  const out: Record<number, EmbeddedDomainChild> = {};
  for (const acc of domainAccounts) {
    const domain = addressToDomain.get(acc.pubkey);
    if (domain === undefined) continue;
    const decoded = decodeMultisigIsmDomainDataAccount(acc.data);
    if (decoded === null) continue;
    out[domain] = buildDomainChild(programId, acc.pubkey, decoded);
  }
  return out;
}

function buildDomainChild(
  programId: Address,
  pda: Address,
  data: DomainData,
): EmbeddedDomainChild {
  return {
    artifactState: ArtifactState.DEPLOYED,
    config: {
      type: 'messageIdMultisigIsm',
      validators: validatorBytesToHex(data.validatorsAndThreshold.validators),
      threshold: data.validatorsAndThreshold.threshold,
    },
    deployed: { address: pda, programId },
  };
}
