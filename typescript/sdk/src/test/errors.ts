export function missingSelectorError(): Error & {
  code: string;
  data: string;
} {
  return Object.assign(new Error('call revert exception (data="0x")'), {
    code: 'CALL_EXCEPTION',
    data: '0x',
  });
}

export function networkError(): Error & { code: string } {
  return Object.assign(new Error('provider unavailable'), {
    code: 'NETWORK_ERROR',
  });
}

export function wrappedError(cause: Error): Error {
  return new Error('wrapped provider error', { cause });
}
