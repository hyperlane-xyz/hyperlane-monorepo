// import { ChainMap } from "@abacus-network/sdk";
// import { BigNumber } from "ethers";
import { BigNumber, ethers } from 'ethers';

import { ChainMap, MultiProvider } from '@abacus-network/sdk';

import { MainnetChains } from '../config/environments/mainnet/chains';
import { AgentKey } from '../src/agents/agent';
import { getAllKeys } from '../src/agents/key-utils';
import { KEY_ROLE_ENUM } from '../src/agents/roles';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

const desiredBalancePerChain: ChainMap<MainnetChains, BigNumber> = {
  celo: ethers.utils.parseUnits('0.05', 'ether'),
  avalanche: ethers.utils.parseUnits('0.1', 'ether'),
  ethereum: ethers.utils.parseUnits('0.1', 'ether'),
  polygon: ethers.utils.parseUnits('1', 'ether'),
  optimism: ethers.utils.parseUnits('0.05', 'ether'),
  arbitrum: ethers.utils.parseUnits('0.01', 'ether'),
  bsc: ethers.utils.parseUnits('0.01', 'ether'),
};

async function main() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);

  const multiProvider = await config.getMultiProvider();

  const relayerKeys = getAllKeys(config.agent).filter(
    (key) => key.role === KEY_ROLE_ENUM.Relayer,
  );

  console.log('Deployer key balances:');
  await printDeployerBalances(multiProvider);

  let addressesToFundPerChain: any = {};
  const insertAddressToFund = async (
    _: MainnetChains,
    remote: MainnetChains,
    address: string,
  ) => {
    if (addressesToFundPerChain[remote]) {
      addressesToFundPerChain[remote].push(address);
    } else {
      addressesToFundPerChain[remote] = [address];
    }
  };
  await forEachRelayerKey(multiProvider, relayerKeys, insertAddressToFund);
  console.log('addressesToFundPerChain', addressesToFundPerChain);

  const printBalance = async (
    local: MainnetChains,
    remote: MainnetChains,
    address: string,
  ) => {
    const provider = multiProvider.getChainConnection(remote).provider;

    const balance = await provider.getBalance(address);

    console.log(
      `Local ${local} remote ${remote} address ${address} balance ${balance} (${ethers.utils.formatEther(
        balance,
      )})`,
    );
  };
  console.log(
    'relayer key balances before',
    await forEachRelayerKey(multiProvider, relayerKeys, printBalance),
  );

  const fundAddress = async (
    local: MainnetChains,
    remote: MainnetChains,
    address: string,
  ) => {
    const deployer = multiProvider.getChainConnection(remote).signer;
    if (!deployer) {
      throw Error(`No deployer signer for ${remote}`);
    }
    const desiredBalance = desiredBalancePerChain[remote];
    const currentBalance = await deployer.provider!.getBalance(address);

    if (desiredBalance > currentBalance) {
      const sendAmount = desiredBalance.sub(currentBalance);

      console.log(
        `Local ${local} remote ${remote} address ${address}, sending ${sendAmount} (${ethers.utils.formatEther(
          sendAmount,
        )}) native tokens to ${address}`,
      );

      const gasPrice = await deployer.getGasPrice();

      console.log('gasPrice', gasPrice.toString());

      try {
        const tx = await deployer.sendTransaction({
          to: address,
          value: sendAmount,
          gasPrice,
        });
        console.log('tx', tx);
        console.log('receipt', await tx.wait());
      } catch (err) {
        // This try/catch was added because of issues with celo-ethers-wrapper.
        // The only way I could get things to run was by changing parseCeloTransaction
        // in node_modules and instead using this `tx` object, which would still
        // result in ethers throwing but at least caused the signed tx to be sent to the network
        //
        //   const tx = {
        //     nonce: handleNumber(transaction[0]).toNumber(),
        //     gasPrice: handleNumber(transaction[1]),
        //     gasLimit: handleNumber(transaction[2]),
        //     feeCurrency: handleAddress('0x'), //transaction[3]),
        //     gatewayFeeRecipient: handleAddress('0x'), // transaction[4]),
        //     gatewayFee: handleNumber('0x'), //transaction[5]),
        //     to: handleAddress(transaction[3]),
        //     value: handleNumber(transaction[4]),
        //     data: transaction[5],
        //     chainId: 0,
        // };
        //
        // Just ignore the error
        console.log('some err', err);
      }
    }
  };

  await forEachRelayerKey(multiProvider, relayerKeys, fundAddress);

  console.log(
    'relayer key balances after',
    await forEachRelayerKey(multiProvider, relayerKeys, printBalance),
  );
}

async function forEachRelayerKey(
  multiProvider: MultiProvider<MainnetChains>,
  relayerKeys: AgentKey[],
  cb: (
    local: MainnetChains,
    remote: MainnetChains,
    address: string,
  ) => Promise<void>,
) {
  for (const relayerKey of relayerKeys) {
    await relayerKey.fetch();
    const relayerAddress = relayerKey.address;

    for (const remote of multiProvider.remoteChains(relayerKey.chainName)) {
      await cb(relayerKey.chainName!, remote, relayerAddress);
    }
  }
}

async function printDeployerBalances(
  multiProvider: MultiProvider<MainnetChains>,
) {
  const deployerAddress = await multiProvider
    .getChainConnection('celo')
    .getAddress()!;

  console.log('deployerAddress', deployerAddress);

  for (const chain of multiProvider.chains()) {
    const balance = await multiProvider
      .getChainConnection(chain)
      .provider.getBalance(deployerAddress);
    console.log(`Chain ${chain} balance: ${ethers.utils.formatEther(balance)}`);
  }
}

main().catch(console.error);
