# [DevBounty AI]: File optimized for resolution.


```javascript
import { Wallet, utils as ethersUtils } from 'ethers';

// ...

export function estimateGas(
  fromAddress: Address,
  contractAddress: Address,
  methodName: string,
  params: any[],
  contractAbi: any,
) {
  const provider = ethersUtils.getDefaultProvider();
  const contract = new ethers.Contract(contractAddress, contractAbi, provider);
  return contract.estimateGas[methodName]({
    from: fromAddress,
    ...params,
  });
}