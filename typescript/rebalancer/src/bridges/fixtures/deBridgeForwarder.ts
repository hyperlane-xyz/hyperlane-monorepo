import { utils } from 'ethers';

import type { BridgeQuote } from '../../interfaces/IExternalBridge.js';
import {
  DLN_FORWARDER_INTERFACE,
  ZERO_EX_ALLOWANCE_INTERFACE,
  ZERO_EX_SETTLER_INTERFACE,
  ZERO_EX_ACTION_INTERFACE,
} from '../deBridgeForwarderValidation.js';
import fixture from './debridge-bsc-forwarder.json' with { type: 'json' };

export { fixture };

export function changeCall(
  iface: utils.Interface,
  data: string,
  change: (args: utils.Result) => readonly unknown[],
): string {
  const decoded = iface.parseTransaction({ data });
  return iface.encodeFunctionData(
    decoded.functionFragment,
    change(decoded.args),
  );
}

export function changeSwap(
  data: string,
  change: (args: utils.Result) => readonly unknown[],
): string {
  return changeCall(DLN_FORWARDER_INTERFACE, data, (outer) => {
    const args = [...outer];
    args[4] = changeCall(
      ZERO_EX_ALLOWANCE_INTERFACE,
      outer.swapData,
      (allowance) => {
        const next = [...allowance];
        next[4] = changeCall(ZERO_EX_SETTLER_INTERFACE, allowance.data, change);
        return next;
      },
    );
    return args;
  });
}

/** Explicit fixture mutation; this is not an unmodified executable provider quote. */
export function withSignerSurplus(signer = fixture.fromAddress): string {
  const data = changeCall(DLN_FORWARDER_INTERFACE, fixture.tx.data, (outer) => {
    const args = [...outer];
    args[7] = signer;
    return args;
  });
  return changeSwap(data, (swap) => {
    const args = [...swap];
    const actions = [...swap.actions];
    actions[actions.length - 1] = changeCall(
      ZERO_EX_ACTION_INTERFACE,
      actions[actions.length - 1],
      (surplus) => {
        const next = [...surplus];
        next[0] = signer;
        return next;
      },
    );
    args[1] = actions;
    return args;
  });
}

/** The captured, unmodified provider payload is the positive semantic fixture. */
export function supportedForwarderData(): string {
  return fixture.tx.data;
}

export function fixtureQuote(): BridgeQuote {
  return {
    id: 'unsigned-forwarder-fixture',
    tool: 'debridge',
    fromAmount: BigInt(fixture.fromAmount),
    toAmount: BigInt(fixture.toAmount),
    toAmountMin: BigInt(fixture.toAmount),
    gasCosts: 0n,
    feeCosts: 0n,
    executionDuration: 60,
    route: {},
    requestParams: {
      fromChain: fixture.fromChain,
      toChain: fixture.toChain,
      fromToken: fixture.fromToken,
      toToken: fixture.toToken,
      fromAmount: BigInt(fixture.fromAmount),
      fromAddress: fixture.fromAddress,
      toAddress: fixture.fromAddress,
    },
  };
}
