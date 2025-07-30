agent-config.json is for relayer. See https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/main/config/testnet_config.json cosmosnative protocols for examples
core-config.yaml is for the core contracts on anvil, we manually create it, but you can also use the cli tool (core init)
warp-route-deployment.yaml is manually created and it's just enough to deploy the anvil warp route contracts. The extra stuff for dymension is just a workaround
