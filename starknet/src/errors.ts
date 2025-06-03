export class ContractError extends Error {
  constructor(
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(`[${code}] ${details ? JSON.stringify(details) : ''}`);
    this.name = 'ContractError';
  }
}
