# CCIP-read server framework

This package implements a straightforward server framework for creating CCIP-read gateway servers.

A CCIP-read gateway server accepts ABI-encoded function calls and responds to them in the same manner as a smart contract, but has access to any external resources it needs. Onchain contracts implementing CCIP-read can request that the client send a query to a gateway server and supply the results back to the contract in a subsequent call.

Typical usage would be a gateway server providing data from a database of some kind, alongside signatures or merkle proofs allowing the calling contract to verify the data's authenticity. With this model, contracts can effectively request data from an external database as part of a contract call or transaction.

Example usage:

```javascript
const ccipread = require('@chainlink/ccip-read-server');
const server = new ccipread.Server();
const abi = ['function getSignedBalance(address addr) public view returns(uint256 balance, bytes memory sig)'];
server.add(abi, [
  {
    type: 'getSignedBalance',
    func: async (contractAddress, [addr]) => {
      const balance = getBalance(addr);
      const sig = signMessage([addr, balance]);
      return [balance, sig];
    },
  },
]);
const app = server.makeApp();
app.listen(8080);
```
