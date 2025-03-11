export class ContractError extends Error {
  code;
  details;
  constructor(code, details) {
    super(`[${code}] ${details ? JSON.stringify(details) : ''}`);
    this.code = code;
    this.details = details;
    this.name = 'ContractError';
  }
}
//# sourceMappingURL=errors.js.map
