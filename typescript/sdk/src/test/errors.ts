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

export function panicRevertError(): Error & { code: string; data: string } {
  return Object.assign(new Error('call revert exception'), {
    code: 'CALL_EXCEPTION',
    data: `0x4e487b71${'0'.repeat(62)}11`,
  });
}

export function lsp17NoExtensionError(): Error & {
  code: string;
  data: string;
} {
  return Object.assign(new Error('call revert exception'), {
    code: 'CALL_EXCEPTION',
    data: `0xbb370b2b${'0'.repeat(56)}46904840`,
  });
}
