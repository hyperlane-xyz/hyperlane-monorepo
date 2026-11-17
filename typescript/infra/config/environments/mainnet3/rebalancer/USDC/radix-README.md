# USDC Radix inventory

USDC/radix and USDC/eclipsemainnet intentionally share the EVM and Solana
inventory addresses in their configs. Their processes track reservations
independently in memory; neither reserves funds exclusively across both routes.

When both routes need funding, each can plan against the same wallet balance.
One may spend inventory the other expected to use, leaving a movement unfunded
or an intent partially fulfilled and stalled. Shared inventory accepts this
liveness tradeoff; adding funds does not coordinate the reservations. There is
no cross-process spend cap or reservation service in this configuration.

Roll out one route at a time and observe settlement before replacing the other.
Monitor shared balances and pending movements across both routes. Before
restarting an instance, reconcile all source submissions and in-flight intents;
a restart loses in-memory tracking and must not be used to blindly retry an
ambiguous transaction. Never overlap old and new execution-enabled instances
of the same route. Wallet separation or shared reservation coordination remains
follow-up work if contention is unacceptable.

The relayer-denylist middleware refreshes the live mainnet list every 60 seconds.
It does not coordinate inventory reservations or recover external bridge orders.
Denylist a rebalancer-owned message only after its funds settled another way.

The image is pinned by digest to merged main at `f18b00f`. This config defaults
to execution; force monitor-only explicitly for local validation. Local
monitoring checks startup and proposals, not quotes, funding or settlement.
