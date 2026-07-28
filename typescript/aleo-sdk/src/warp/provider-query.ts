import { assert, ensure0x, retryAsync } from '@hyperlane-xyz/utils';

import type { AnyAleoNetworkClient } from '../clients/base.js';
import {
  RETRY_ATTEMPTS,
  RETRY_DELAY_MS,
  fromAleoAddress,
} from '../utils/helper.js';
import type { AleoPlaintextRuntime } from '../utils/provable.js';

/** Returns the ARC-20 token program imported by an ARC-20 warp token. */
export async function getArc20ProgramId(
  aleoClient: AnyAleoNetworkClient,
  warpProgramId: string,
): Promise<string> {
  const imports = await aleoClient.getProgramImportNames(warpProgramId);
  const arc20ProgramId = imports.find(
    (i) => i.includes('arc20') && !i.includes('multisig'),
  );
  assert(
    arc20ProgramId,
    `Could not find ARC-20 token import in program ${warpProgramId}`,
  );
  return arc20ProgramId;
}

/** Extracts the first wire-format output from a view function response. */
export function parseViewFunctionOutputs(
  outputs: unknown,
  programId: string,
  viewName: string,
): string {
  assert(
    Array.isArray(outputs) &&
      outputs.length > 0 &&
      typeof outputs[0] === 'string',
    `View function ${programId}/${viewName} returned an unexpected response shape: ${JSON.stringify(outputs)}`,
  );
  return outputs[0];
}

/** Calls an Aleo program view function through the Explorer REST API. */
export async function callViewFunction(
  aleoClient: AnyAleoNetworkClient,
  programId: string,
  viewName: string,
  inputs: string[] = [],
): Promise<string> {
  const url = `${aleoClient.host}/program/${programId}/view/${viewName}`;
  const body = inputs.length === 0 ? '{}' : JSON.stringify(inputs);
  return retryAsync(
    async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      assert(res.ok, `View function call failed (${res.status}): ${url}`);
      const outputs: unknown = await res.json();
      return parseViewFunctionOutputs(outputs, programId, viewName);
    },
    RETRY_ATTEMPTS,
    RETRY_DELAY_MS,
  );
}

/** Parses a raw Aleo uint literal such as `1000000u128`. */
export function parseAleoUint(raw: string): bigint {
  const match = raw.match(/^(\d+)/);
  assert(match, `Expected numeric Aleo literal, got: ${raw}`);
  return BigInt(match[1]);
}

function parseAleoIdentifier(raw: string): string {
  return raw.replace(/^'|'$/g, '');
}

/** Queries token metadata from an ARC-20 token program's view functions. */
export async function getArc20TokenMetadata(
  aleoClient: AnyAleoNetworkClient,
  arc20ProgramId: string,
): Promise<{ name: string; symbol: string; decimals: number }> {
  const [nameRaw, symbolRaw, decimalsRaw] = await Promise.all([
    callViewFunction(aleoClient, arc20ProgramId, 'name'),
    callViewFunction(aleoClient, arc20ProgramId, 'symbol'),
    callViewFunction(aleoClient, arc20ProgramId, 'decimals'),
  ]);
  const decimals = parseInt(decimalsRaw, 10);
  assert(
    !Number.isNaN(decimals),
    `Expected numeric decimals from ${arc20ProgramId}, got: ${decimalsRaw}`,
  );

  return {
    name: parseAleoIdentifier(nameRaw),
    symbol: parseAleoIdentifier(symbolRaw),
    decimals,
  };
}

/** Queries a warp token's remote routers with the selected network runtime. */
export async function getRemoteRouters(
  sdk: AleoPlaintextRuntime,
  aleoClient: AnyAleoNetworkClient,
  tokenAddress: string,
): Promise<Record<number, { address: string; gas: string }>> {
  const { programId } = fromAleoAddress(tokenAddress);
  const remoteRouters: Record<number, { address: string; gas: string }> = {};
  const routerLengthRes = await aleoClient.getProgramMappingValue(
    programId,
    'remote_router_length',
    'true',
  );

  if (!routerLengthRes) return remoteRouters;

  const routerLength = parseInt(routerLengthRes);
  assert(
    !isNaN(routerLength) && routerLength >= 0,
    `Expected remote_router_length to be a non-negative number for token ${tokenAddress} but got ${routerLengthRes}`,
  );

  for (let i = 0; i < routerLength; i++) {
    const routerKey = await aleoClient.getProgramMappingPlaintext(
      programId,
      'remote_router_iter',
      `${i}u32`,
    );
    if (!routerKey) continue;

    const remoteRouterValue = await aleoClient.getProgramMappingValue(
      programId,
      'remote_routers',
      routerKey,
    );
    if (!remoteRouterValue) continue;

    const remoteRouter = sdk.Plaintext.fromString(remoteRouterValue).toObject();
    const domainId = Number(remoteRouter['domain']);
    if (remoteRouters[domainId]) continue;

    assert(
      Array.isArray(remoteRouter['recipient']),
      `Expected recipient to be an array in remote router for domain ${domainId} but got ${typeof remoteRouter['recipient']}`,
    );
    remoteRouters[domainId] = {
      address: ensure0x(Buffer.from(remoteRouter['recipient']).toString('hex')),
      gas: remoteRouter['gas'].toString(),
    };
  }

  return remoteRouters;
}
