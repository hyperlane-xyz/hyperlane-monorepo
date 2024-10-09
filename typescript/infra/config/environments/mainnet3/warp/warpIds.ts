export enum WarpRouteIds {
  Ancient8EthereumUSDC = 'USDC/ancient8-ethereum',
  ArbitrumBaseBlastBscEthereumFraxtalLineaModeOptimismZircuitEZETH = 'EZETH/arbitrum-base-blast-bsc-ethereum-fraxtal-linea-mode-optimism-zircuit',
  ArbitrumNeutronEclip = 'ECLIP/arbitrum-neutron',
  ArbitrumNeutronTIA = 'TIA/arbitrum-neutron',
  EclipseSolanaSOL = 'SOL/eclipsemainnet-solanamainnet',
  EclipseSolanaWIF = 'WIF/eclipsemainnet-solanamainnet',
  EthereumInevmUSDC = 'USDC/ethereum-inevm',
  EthereumInevmUSDT = 'USDT/ethereum-inevm',
  EthereumEclipseTETH = 'tETH/eclipsemainnet-ethereum',
  EthereumEclipseUSDC = 'USDC/eclipsemainnet-ethereum-solanamainnet',
  EthereumVictionETH = 'ETH/ethereum-viction',
  EthereumVictionUSDC = 'USDC/ethereum-viction',
  EthereumVictionUSDT = 'USDT/ethereum-viction',
  EthereumZircuitPZETH = 'PZETH/ethereum-zircuit',
  InevmInjectiveINJ = 'INJ/inevm-injective',
  MantapacificNeutronTIA = 'TIA/mantapacific-neutron',
}

// add new warp route ids here if they are supported by the checker tooling, add an entry to warpConfigGetterMap also
export enum CheckerWarpRouteIds {
  Ancient8EthereumUSDC = WarpRouteIds.Ancient8EthereumUSDC,
  ArbitrumBaseBlastBscEthereumFraxtalLineaModeOptimismZircuitEZETH = WarpRouteIds.ArbitrumBaseBlastBscEthereumFraxtalLineaModeOptimismZircuitEZETH,
  ArbitrumNeutronEclip = WarpRouteIds.ArbitrumNeutronEclip,
  ArbitrumNeutronTIA = WarpRouteIds.ArbitrumNeutronTIA,
  EthereumInevmUSDC = WarpRouteIds.EthereumInevmUSDC,
  EthereumInevmUSDT = WarpRouteIds.EthereumInevmUSDT,
  EthereumVictionETH = WarpRouteIds.EthereumVictionETH,
  EthereumVictionUSDC = WarpRouteIds.EthereumVictionUSDC,
  EthereumVictionUSDT = WarpRouteIds.EthereumVictionUSDT,
  EthereumZircuitPZETH = WarpRouteIds.EthereumZircuitPZETH,
  InevmInjectiveINJ = WarpRouteIds.InevmInjectiveINJ,
  MantapacificNeutronTIA = WarpRouteIds.MantapacificNeutronTIA,
}
