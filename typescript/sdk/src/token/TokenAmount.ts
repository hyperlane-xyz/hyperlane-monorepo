import { Numberish, fromWei } from '@hyperlane-xyz/utils';

import type { ITokenMetadata } from './ITokenMetadata.js';

export class TokenAmount<TToken extends ITokenMetadata = ITokenMetadata> {
  public readonly amount: bigint;

  constructor(
    _amount: Numberish,
    public readonly token: TToken,
  ) {
    this.amount = BigInt(_amount);
  }

  getDecimalFormattedAmount(): number {
    return Number(fromWei(this.amount.toString(), this.token.decimals));
  }

  plus(amount: Numberish): TokenAmount<TToken> {
    return new TokenAmount(this.amount + BigInt(amount), this.token);
  }

  minus(amount: Numberish): TokenAmount<TToken> {
    return new TokenAmount(this.amount - BigInt(amount), this.token);
  }

  equals(tokenAmount: TokenAmount): boolean {
    return (
      this.amount === tokenAmount.amount && this.token.equals(tokenAmount.token)
    );
  }
}
