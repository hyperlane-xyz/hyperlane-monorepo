# USDC Eclipse and Elysium inventory

Elysium uses weight 3, tolerance 3 and a 2,500 USDC economic minimum, matching
HyperEVM. The existing 15 chains keep their weights, thresholds, movable-collateral
bridges and inventory signers. Existing BSC/Solana inventory routes keep swaps.xyz
and its shared `mainnet3-swapsxyz-api-key` secret.

Physical inventory routes are separate from economic surplus/deficit proposals:

- Funded HyperEVM inventory deposits canonical USDC into Elysium through the native
  bridge, with priority over other sources. HyperEVM needs no router imbalance.
- Other configured EVM/Elysium pairs use direct Relay in both directions.
- Native withdrawals from Elysium are unsupported. Elysium/Solana pairs are
  disabled in both the strategy and physical inventory policy.
- An empty HyperEVM wallet is not an automatic intermediate hop. Other funded
  sources can bridge directly to Elysium through Relay.

Relay permits at most 1% total USDC quote loss, including its 0.1% slippage
tolerance. Quotes outside this budget are skipped. Native deposits preserve USDC
1:1 and attach at most 0.01 HYPE for retryable delivery; parent gas is additional.
There is no automatic alternative-provider fallback for an explicitly configured
physical pair. Existing source-capacity and reservation accounting still apply.

The 2% allowance used for small live canaries is a test-only override and is not
part of this configuration. Failed native automatic redemption requires manual
recovery using the logged source transaction/retryable identity. Tracking remains
in memory; process restarts can lose outstanding work, as accepted for this rollout.

The registry pin rebases the Elysium route from registry PR #1792 onto registry
main `53094a44`, retaining the Eclipse synthetic mint required for balance reads.
It is published on the separate `codex/usdc-eclipse-monitor-registry-nov10`
validation branch; the original registry PR is unchanged. Before production
activation, use an accepted Elysium-containing registry revision and
verify deployed router enrollment, collateral identity, signer permissions and gas.
The pinned amd64 image was built from shared-stack commit `11861e50a5` and
verified against its published digest and revision label. It includes Relay,
physical inventory routing and native deposits.
This configuration is persisted in monitor-only mode. Validation stops after local
monitor-only runs; the existing production deployment is unchanged. Monitor-only
checks validate startup, balances and strategy reads, but do not construct provider
executors or validate live quotes, funding or settlement.

For any separately planned EVM wallet funding into HyperEVM, prefer the existing
`USDC/mainnet-cctp-v2-standard` route where supported. LI.FI/Polymer was used only
to fund the small native-bridge canary; it is not configured here. Automatic
CCTP-to-HyperEVM-to-Elysium transit remains outside this change.

Live canaries verified direct Relay in both directions and a canonical deposit
with automatic redemption. The native leg preserved 4.9875 USDC exactly. Both
round trips returned to Base, and all five canary approval allowances were zero
after settlement. One Relay return needed a fresh quote after its post-approval
minimum changed; strict accepted quote bounds remain enforced.
