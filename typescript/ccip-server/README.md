# CCIP-read service framework

This package contains the service framework for the CCIP-read project, built off of the [CCIP-server framework](https://github.com/smartcontractkit/ccip-read). It allows building of any execution logic, given a Hyperlane Relayer call.

# Definitions

- Server: The main entry point, and refers to `server.ts`.
- Service: A class that handles all logic for a particular service, e.g. ProofService, RPCService, etc.
- Service ABI: The interface for a service that tells the Server what input and output to expect. It serves similar functionalities as the Solidity ABIs, i.e., used for encoding and decoding data.

# Usage

The Relayer will make a POST request to the Server with a request body similar to the following:

```json
{
  "data": "0x0ee9bb2f000000000000000000000000873afca0319f5c04421e90e882566c496877aff8000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001a2d9059b6d822aa460229510c754e9ecec100bb9f649186f5c7d4da8edf59858",
  "sender": "0x4a679253410272dd5232b3ff7cf5dbb88f295319"
}
```

The `data` property will be ABI-encoded, and server will parse it according to the Service ABI. It then will call the handler function with the parsed input.

# Building a Service

1. Create a Service ABI for your Service. This ABI tells the Server how to parse the incoming `data`, and how to encode the output. See `/abi/ProofsServiceAbi.ts` for an example.
2. Create a new Service class to handle your logic. This should inherit from `HandlerDescriptionEnumerated` if a function will be used to handle a Server request. The handler function should return a Promise that resolves to the output of the Service. See `/service/ProofsService.ts` for examples.
3. Instantiate the new Service in `server.ts`. For example:

```typescript
const proofsService = new ProofsService(
  config.LIGHT_CLIENT_ADDR,
  config.RPC_ADDRESS,
  config.STEP_FN_ID,
  config.CHAIN_ID,
  config.SUCCINCT_PLATFORM_URL,
  config.SUCCINCT_API_KEY,
);
```

4. Add the new Service by calling `server.add(...)` by providing the Service ABI, and the handler function. For example:

```typescript
server.add(ProofsServiceAbi, [proofsService.handler('getProofs')]);
```
