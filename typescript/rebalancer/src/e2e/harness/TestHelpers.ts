import {BigNumber, providers} from "ethers";

import {HyperlaneCore, MultiProvider} from "@hyperlane-xyz/sdk";
import {assert} from "@hyperlane-xyz/utils";
import {ERC20Test__factory} from "@hyperlane-xyz/core";
import {expect} from "chai";

import type {RebalanceAction} from "../../tracking/types.js";
import type {MonitorEvent} from "../../interfaces/IMonitor.js";
import {MonitorEventType} from "../../interfaces/IMonitor.js";
import type {Monitor} from "../../monitor/Monitor.js";
import type {TestRebalancerContext} from "./TestRebalancer.js";
import {tryRelayMessage} from "./TransferHelper.js";

import {
    DOMAIN_IDS,
    type Erc20InventoryDeployedAddresses,
    type NativeDeployedAddresses,
    TEST_CHAINS,
} from "../fixtures/routes.js";

export async function getFirstMonitorEvent(
    monitor: Monitor,
): Promise<MonitorEvent> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error("Monitor event timeout"));
        }, 60_000);

        monitor.on(MonitorEventType.TokenInfo, (event: MonitorEvent) => {
            clearTimeout(timeout);
            void monitor.stop();
            resolve(event);
        });

        monitor.on(MonitorEventType.Error, (error: Error) => {
            clearTimeout(timeout);
            void monitor.stop();
            reject(error);
        });

        void monitor.start();
    });
}

export function chainFromDomain(domain: number): string {
    const found = Object.entries(DOMAIN_IDS).find(([, d]) => d === domain);
    if (!found) {
        throw new Error(`Unknown domain: ${domain}`);
    }
    return found[0];
}

export async function getRouterBalances(
    localProviders: Map<string, providers.JsonRpcProvider>,
    addresses: NativeDeployedAddresses,
): Promise<Record<string, BigNumber>> {
    const balances: Record<string, BigNumber> = {};
    for (const chain of TEST_CHAINS) {
        const provider = localProviders.get(chain);
        assert(provider, `Missing provider for chain ${chain}`);
        balances[chain] = await provider.getBalance(
            addresses.monitoredRoute[chain],
        );
    }
    return balances;
}

export async function getErc20RouterBalances(
    localProviders: Map<string, providers.JsonRpcProvider>,
    addresses: Erc20InventoryDeployedAddresses,
): Promise<Record<string, BigNumber>> {
    const balances: Record<string, BigNumber> = {};
    for (const chain of TEST_CHAINS) {
        const provider = localProviders.get(chain)!;
        const token = ERC20Test__factory.connect(
            addresses.tokens[chain],
            provider,
        );
        balances[chain] = await token.balanceOf(
            addresses.monitoredRoute[chain],
        );
    }
    return balances;
}

export interface ChainRoles {
    deficitChain: string;
    surplusChain: string;
    neutralChain?: string;
}

/**
 * Classify chains into deficit, surplus, and neutral based on a deposit action.
 *
 * For inventory deposits the execution direction is swapped: the action's
 * destination is the surplus chain (where the router pays out on delivery).
 */
export function classifyChains(
    deficitChain: string,
    depositAction: RebalanceAction,
): ChainRoles {
    const surplusChain = chainFromDomain(depositAction.destination);
    const neutralChain = TEST_CHAINS.find(
        (c) => c !== deficitChain && c !== surplusChain,
    );
    return {deficitChain, surplusChain, neutralChain};
}

export async function relayInProgressInventoryDeposits(
    context: TestRebalancerContext,
    localProviders: Map<string, providers.JsonRpcProvider>,
    multiProvider: MultiProvider,
    hyperlaneCore: HyperlaneCore,
): Promise<void> {
    const inProgressActions = await context.tracker.getInProgressActions();
    const depositActions = inProgressActions.filter(
        (a) => a.type === "inventory_deposit" && a.txHash && a.messageId,
    );

    for (const action of depositActions) {
        const origin = chainFromDomain(action.origin);
        const destination = chainFromDomain(action.destination);
        const provider = localProviders.get(origin);
        assert(provider, `Missing provider for chain ${origin}`);
        assert(
            action.txHash,
            `Missing txHash for action ${action.origin}->${action.destination}`,
        );
        const dispatchTx = await provider.getTransactionReceipt(action.txHash);

        assert(
            action.messageId,
            `Missing messageId for action ${action.origin}->${action.destination}`,
        );
        const relayResult = await tryRelayMessage(
            multiProvider,
            hyperlaneCore,
            {
                dispatchTx,
                messageId: action.messageId,
                origin,
                destination,
            },
        );

        expect(
            relayResult.success,
            `Inventory deposit relay should succeed: ${relayResult.error}`,
        ).to.be.true;
    }

    // Use provider.send to bypass ethers v5 _maxInternalBlockNumber cache
    // which refuses to return lower block numbers after evm_revert.
    const tags: Record<string, number> = {};
    for (const chain of TEST_CHAINS) {
        const p = localProviders.get(chain);
        assert(p, `Missing provider for chain ${chain}`);
        const hex = await p.send("eth_blockNumber", []);
        tags[chain] = parseInt(hex, 16);
    }
    await context.tracker.syncRebalanceActions(tags);
}
