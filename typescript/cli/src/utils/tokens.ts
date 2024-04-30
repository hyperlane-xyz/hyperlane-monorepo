import select from '@inquirer/select';

import { Token } from '@hyperlane-xyz/sdk';

export async function runTokenSelectionStep(
  tokens: Token[],
  message = 'Select token',
) {
  const choices = tokens.map((t) => ({
    name: `${t.symbol} - ${t.addressOrDenom}`,
    value: t.addressOrDenom,
  }));
  const routerAddress = (await select({
    message,
    choices,
    pageSize: 20,
  })) as string;
  return routerAddress;
}
