// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {PackageVersioned} from "contracts/PackageVersioned.sol";

interface IBlockHashOracle {
    uint32 public immutable origin;

    function blockhash(uint256 height) external view returns (uint256 hash);
}

contract BlockHashISM is IInterchainSecurityModule, PackageVersioned {
    uint8 public constant override moduleType = uint8(Types.NULL); //TODO
    IBlockHashOracle public immutable oracle;

    /**
     * @inheritdoc IInterchainSecurityModule
     * @notice Verifies whether a message was dispatched on the origin chain using a block hash oracle.
     */
    function verify(
        bytes calldata metadata,
        bytes calldata message
    ) public pure override returns (bool) {
        (bytes32 blockHash, uint256 blockHeight) = abi.decode(
            metadata,
            (bytes32, uint256)
        );

        // if the block hash at the specified height does not match the oracle results means the transaction was not mined on that origin chain
        require(
            oracle.blockhash(blockHeight) == blockHash,
            "Transaction not dispatched from origin chain"
        );
        // TODO use the rlp decoder for solidity maybe why
        return true; // TODO
    }
    //TODO how could an untrusted relayer be verified here, or how can we avoid an unstruted relayer messing around
}

/*
Assume you have some magical origin chain block hash oracle on the destination chain.

```solidity
interface IBlockHashOracle {
		uint32 public immutable origin;
		function blockhash(uint256 height) external view returns (uint256 hash);
}
```

Implement a `BlockHashISM` that verifies whether a message was dispatched on the origin chain using this oracle. You can assume that the origin chain uses the [ethereum block format](https://ethereum.org/en/developers/docs/blocks/#block-anatomy). 

When you’re done implementing OptimisticISM, please **create a PR on your forked repo** merging `solidity-challenge` back into `main` and reach back out with a link to this PR. 

We expect this challenge to take a few hours to complete, but feel free to spend as little or as much time as you like. As always, please do not hesitate to reach out if you have any questions or feedback.

**Assumptions:**

- BlockHashOracle is trusted
- Relayers are untrusted

**Design goals:**

- Simplicity
- Gas efficiency
*/
