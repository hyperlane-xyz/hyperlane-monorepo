// alert queries currently need to support special cases i.e cross VM (sealevel and cosmos chains) and ata payer (sealevel). These special cases are hard coded for now. We aim to add cross VM support to the key and will be able to remove special casing in the future
export const LOW_URGENCY_KEY_FUNDER_HEADER = `# Note: use last_over_time(hyperlane_wallet_balance{}[1d]) to be resilient to gaps in the 'hyperlane_wallet_balance'
# that occur due to key funder only running every hour or so.

min by (chain, wallet_address, wallet_name) (
    # Mainnets`;

export const LOW_URGENCY_KEY_FUNDER_FOOTER = `    # Mainnets that don't use key-funder and all funds are stored in the relayer's wallet
    # Eclipse
    last_over_time(hyperlane_wallet_balance{wallet_name="relayer", hyperlane_context="hyperlane", chain=~"eclipsemainnet"}[1d]) - 1 or
    # Any ATA payer on Eclipse
    last_over_time(hyperlane_wallet_balance{wallet_name=~".*/ata-payer", chain=~"eclipsemainnet"}[1d]) - 0.01 or
    # SOL/eclipsemainnet-solanamainnet
    last_over_time(hyperlane_wallet_balance{wallet_name=~"SOL/eclipsemainnet-solanamainnet/ata-payer | USDC/eclipsemainnet-ethereum-solanamainnet/ata-payer", chain=~"eclipsemainnet"}[1d]) - 0.1 or

    # Solana
    last_over_time(hyperlane_wallet_balance{wallet_name="relayer", hyperlane_context="hyperlane", chain=~"solanamainnet"}[1d]) - 27 or
    # Any ATA payer on Solana
    last_over_time(hyperlane_wallet_balance{wallet_name=~".*/ata-payer", chain=~"solanamainnet"}[1d]) - 0.2 or
    # Any ATA payer on Solana
    last_over_time(hyperlane_wallet_balance{wallet_name=~"USDC/eclipsemainnet-ethereum-solanamainnet/ata-payer", chain=~"solanamainnet"}[1d]) - 0.8 or

    # SOON
    last_over_time(hyperlane_wallet_balance{wallet_name="relayer", hyperlane_context="hyperlane", chain=~"soon"}[1d]) - 0.1 or
    # Any ATA payer on SOON
    last_over_time(hyperlane_wallet_balance{wallet_name=~".*/ata-payer", chain=~"soon"}[1d]) - 0.01 or

    # Sonic SVM
    last_over_time(hyperlane_wallet_balance{wallet_name="relayer", hyperlane_context="hyperlane", chain=~"sonicsvm"}[1d]) - 4 or
    # Any ATA payer on SonicSVM
    last_over_time(hyperlane_wallet_balance{wallet_name=~".*/ata-payer", chain=~"sonicsvm"}[1d]) - 0.1 or
    
    # Neutron context
    last_over_time(hyperlane_wallet_balance{wallet_name="relayer", chain="mantapacific", hyperlane_context="neutron"}[1d]) - 0.3 or
    last_over_time(hyperlane_wallet_balance{wallet_name="relayer", chain="arbitrum", hyperlane_context="neutron"}[1d]) - 0.3 or
    last_over_time(hyperlane_wallet_balance{wallet_name="relayer", chain="neutron", hyperlane_context="neutron"}[1d]) - 1500 or

    # Injective
    (last_over_time(hyperlane_wallet_balance{wallet_name="relayer", chain="injective", wallet_address!~"inj1ddw6pm84zmtpms0gpknfsejkk9v6t0ergjpl30|inj1ds32d5t26j7gauvtly86lk6uh06ear3jvqllaw"}[1d]) / 1000000000000) - 3 or

    # Stride
    (last_over_time(hyperlane_wallet_balance{wallet_name="relayer", chain="stride"}[1d])) - 10
`;

export const LOW_URGENCY_ENG_KEY_FUNDER_FOOTER = `    # Mainnets that don't use key-funder and all funds are stored in the relayer's wallet
    # Eclipse
    last_over_time(hyperlane_wallet_balance{wallet_name="relayer", hyperlane_context="hyperlane", chain=~"eclipsemainnet"}[1d]) - 0.5 or
    # Any ATA payer on Eclipse
    last_over_time(hyperlane_wallet_balance{wallet_name=~".*/ata-payer", chain=~"eclipsemainnet"}[1d]) - 0.005 or
    # SOL/eclipsemainnet-solanamainnet
    last_over_time(hyperlane_wallet_balance{wallet_name=~"SOL/eclipsemainnet-solanamainnet/ata-payer | USDC/eclipsemainnet-ethereum-solanamainnet/ata-payer", chain=~"eclipsemainnet"}[1d]) - 0.05 or

    # Solana
    last_over_time(hyperlane_wallet_balance{wallet_name="relayer", hyperlane_context="hyperlane", chain=~"solanamainnet"}[1d]) - 13.5 or
    # Any ATA payer on Solana
    last_over_time(hyperlane_wallet_balance{wallet_name=~".*/ata-payer", chain=~"solanamainnet"}[1d]) - 0.1 or
    # Any ATA payer on Solana
    last_over_time(hyperlane_wallet_balance{wallet_name=~"USDC/eclipsemainnet-ethereum-solanamainnet/ata-payer", chain=~"solanamainnet"}[1d]) - 0.4 or

    # SOON
    last_over_time(hyperlane_wallet_balance{wallet_name="relayer", hyperlane_context="hyperlane", chain=~"soon"}[1d]) - 0.05 or
    # Any ATA payer on SOON
    last_over_time(hyperlane_wallet_balance{wallet_name=~".*/ata-payer", chain=~"soon"}[1d]) - 0.005 or

    # Sonic SVM 
    last_over_time(hyperlane_wallet_balance{wallet_name="relayer", hyperlane_context="hyperlane", chain=~"sonicsvm"}[1d]) - 2 or
    # Any ATA payer on SonicSVM
    last_over_time(hyperlane_wallet_balance{wallet_name=~".*/ata-payer", chain=~"sonicsvm"}[1d]) - 0.05 or
    
    # Neutron context
    last_over_time(hyperlane_wallet_balance{wallet_name="relayer", chain="mantapacific", hyperlane_context="neutron"}[1d]) - 0.15 or
    last_over_time(hyperlane_wallet_balance{wallet_name="relayer", chain="arbitrum", hyperlane_context="neutron"}[1d]) - 0.15 or
    last_over_time(hyperlane_wallet_balance{wallet_name="relayer", chain="neutron", hyperlane_context="neutron"}[1d]) - 750 or

    # Injective
    (last_over_time(hyperlane_wallet_balance{wallet_name="relayer", chain="injective", wallet_address!~"inj1ddw6pm84zmtpms0gpknfsejkk9v6t0ergjpl30|inj1ds32d5t26j7gauvtly86lk6uh06ear3jvqllaw"}[1d]) / 1000000000000) - 1.5 or

    # Stride
    (last_over_time(hyperlane_wallet_balance{wallet_name="relayer", chain="stride"}[1d])) - 5
`;

export const HIGH_URGENCY_RELAYER_HEADER = `min by (chain, wallet_address, wallet_name) (
    # Mainnets`;

export const HIGH_URGENCY_RELAYER_FOOTER = `    # Special contexts already have hyperlane_context set correctly

    # Eclipse
    last_over_time(hyperlane_wallet_balance{wallet_name=~".*/ata-payer", chain=~"eclipsemainnet"}[1d]) - 0.001 or

    # Solana
    last_over_time(hyperlane_wallet_balance{wallet_name=~".*/ata-payer", chain=~"solanamainnet"}[1d]) - 0.1 or

    # SOON
    # Any ATA payer on SOON
    last_over_time(hyperlane_wallet_balance{wallet_name=~".*/ata-payer", chain=~"soon"}[1d]) - 0.005 or
    
    # Sonic SVM
    last_over_time(hyperlane_wallet_balance{wallet_name=~".*/ata-payer", chain=~"sonicsvm"}[1d]) - 0.075 or

    # Neutron context lines stay with neutron context
    last_over_time(hyperlane_wallet_balance{wallet_name="relayer", chain="mantapacific", hyperlane_context="neutron"}[1d]) - 0.02 or
    last_over_time(hyperlane_wallet_balance{wallet_name="relayer", chain="arbitrum", hyperlane_context="neutron"}[1d]) - 0.02 or
    last_over_time(hyperlane_wallet_balance{wallet_name="relayer", chain="neutron", hyperlane_context="neutron"}[1d]) - 0.7
`;
