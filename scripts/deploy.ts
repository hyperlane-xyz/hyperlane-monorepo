import yargs from 'yargs';
import { ethers } from 'ethers';
import path from "path";
import fs from "fs";
import {
  MultiProvider,
  chainConnectionConfigs,
  objMap,
  serializeContracts,
} from '@hyperlane-xyz/sdk';
import { HypERC20Deployer } from "../src/deploy";  

// Function that takes 2 CLI arguments, the private key and the token config file
async function deployTradeRoute() {
  const argv = await yargs
  .option('private-key', {
    type: 'string',
    describe: 'Private key for signing transactions',
    demandOption: true,
  })
  .option('config', {
    type: 'string',
    describe: 'Path to JSON config file',
    demandOption: true,
  })
  .argv;

  const signer = new ethers.Wallet(argv['private-key']);
    const config = JSON.parse(fs.readFileSync(path.resolve(argv.config), "utf-8"))
    const multiProvider = new MultiProvider(
      objMap(chainConnectionConfigs, (_chain, conf) => ({
        ...conf,
        signer: signer.connect(conf.provider),
      })),
    );

    const deployer = new HypERC20Deployer(multiProvider, config, undefined);
    await deployer.deploy();

    console.log('Deployment successful. Deployed contracts:')
    // @ts-ignore
    console.log(serializeContracts(deployer.deployedContracts))
}

deployTradeRoute().then(console.log).catch(console.error)