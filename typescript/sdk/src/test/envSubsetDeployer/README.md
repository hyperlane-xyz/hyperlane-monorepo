# Environment Subset Deployer App

A trivial app intended to test deployments to a subset of an environment's chains.
For example, test deploying to just alfajores from env `testnet2`.

To test deployment to a local hardhat network, run `yarn test:hardhat`
To test actual deployments to Alfajores run `MNEMONIC="your_mnemonic" yarn ts-node src/test/envSubsetDeployer/deploy-single-chain.ts`
To check run `yarn ts-node src/test/envSubsetDeployer/check-single-chain.ts`
