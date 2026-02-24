import { Address } from '@hyperlane-xyz/utils';

export type HexData = `0x${string}`;

export type EthCallRequest = {
  to: string;
  data: string;
  from?: string;
};

export type AddressReaderContract = {
  address: string;
  interface: {
    encodeFunctionData(functionName: string, args?: readonly unknown[]): string;
    decodeFunctionResult(functionName: string, data: HexData): unknown;
  };
};

type CallLike = {
  call: (request: EthCallRequest) => Promise<unknown>;
};

type RequestLike = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

type SendLike = {
  send: (method: string, params?: unknown[]) => Promise<unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isHexData(value: unknown): value is HexData {
  return typeof value === 'string' && value.startsWith('0x');
}

function hasCall(value: unknown): value is CallLike {
  return isRecord(value) && typeof value.call === 'function';
}

function hasRequest(value: unknown): value is RequestLike {
  return isRecord(value) && typeof value.request === 'function';
}

function hasSend(value: unknown): value is SendLike {
  return isRecord(value) && typeof value.send === 'function';
}

export function isAddressReaderContract(
  value: unknown,
): value is AddressReaderContract {
  if (!isRecord(value) || typeof value.address !== 'string') return false;
  if (!isRecord(value.interface)) return false;
  return (
    typeof value.interface.encodeFunctionData === 'function' &&
    typeof value.interface.decodeFunctionResult === 'function'
  );
}

function extractCallData(result: unknown): HexData | undefined {
  if (isHexData(result)) return result;
  if (!isRecord(result)) return undefined;
  if (isHexData(result.data)) return result.data;
  if (isHexData(result.result)) return result.result;
  return undefined;
}

export async function performEthCall(
  provider: unknown,
  request: EthCallRequest,
  errorMessage = 'Provider does not support eth_call',
  seen = new Set<unknown>(),
): Promise<HexData> {
  if (!isRecord(provider)) throw new Error(errorMessage);
  if (seen.has(provider)) throw new Error(errorMessage);
  seen.add(provider);

  if (hasCall(provider)) {
    const callData = extractCallData(await provider.call(request));
    if (callData) return callData;
  }

  if (hasRequest(provider)) {
    const callData = extractCallData(
      await provider.request({
        method: 'eth_call',
        params: [request, 'latest'],
      }),
    );
    if (callData) return callData;
  }

  if (hasSend(provider)) {
    const callData = extractCallData(
      await provider.send('eth_call', [request, 'latest']),
    );
    if (callData) return callData;
  }

  if ('provider' in provider && provider.provider !== undefined) {
    return performEthCall(provider.provider, request, errorMessage, seen);
  }

  throw new Error(errorMessage);
}

export function isAddressString(value: unknown): value is Address {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value);
}

export function asHexAddress(value: string, label = 'address'): `0x${string}` {
  if (!isAddressString(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return value as `0x${string}`;
}

export function normalizeAddressResult(
  value: unknown,
  functionName: string,
): Address {
  if (isAddressString(value)) return value;
  if (Array.isArray(value) && isAddressString(value[0])) return value[0];
  if (isRecord(value)) {
    if (isAddressString(value['0'])) return value['0'];
    if (isAddressString(value.address)) return value.address;
    if (isAddressString(value.target)) return value.target;
    if (isAddressString(value.result)) return value.result;
    if (isAddressString(value.value)) return value.value;
    const embeddedAddress = Object.values(value).find((entry) =>
      isAddressString(entry),
    );
    if (embeddedAddress) return embeddedAddress;
  }
  if (
    value &&
    typeof value === 'object' &&
    'toString' in value &&
    typeof value.toString === 'function'
  ) {
    const serialized = value.toString();
    if (isAddressString(serialized)) return serialized;
  }
  throw new Error(`Unable to decode address result for ${functionName}`);
}

export async function readAddressWithCall(
  provider: unknown,
  contract: AddressReaderContract,
  functionName: string,
  errorMessage = 'Provider does not support call for address read',
): Promise<Address> {
  const callData = await performEthCall(
    provider,
    {
      to: contract.address,
      data: contract.interface.encodeFunctionData(functionName),
    },
    errorMessage,
  );
  return normalizeAddressResult(
    contract.interface.decodeFunctionResult(functionName, callData),
    functionName,
  );
}
