// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {PackageVersioned} from "contracts/PackageVersioned.sol";
import {Message} from "../libs/Message.sol";

interface IBlockHashOracle {
    uint32 public immutable origin;

    function blockhash(uint256 height) external view returns (uint256 hash);
}

contract BlockHashISM is IInterchainSecurityModule, PackageVersioned {
    using Message for bytes;
    uint8 public constant override moduleType = uint8(Types.NULL);
    IBlockHashOracle public immutable oracle;

    /**
     * @inheritdoc IInterchainSecurityModule
     * @notice Verifies whether a message was dispatched on the origin chain using a block hash oracle against the
     * block hash contained inside the message.
     * @dev The `message` parameter must be ABI-encoded with the `blockHash` (as `uint256`) and `blockHeight` (as `uint256`)
     * as the first two parameters, followed by any additional data.
     * @param message Message to verify.
     */
    function verify(
        bytes calldata,
        bytes calldata message
    ) public pure override returns (bool) {
        (uint256 blockHash, uint256 blockHeight) = _extractBlockInfo(
            message.body()
        );

        // if the block hash at the specified height does not match the oracle results means the transaction was not mined on that origin chain
        require(
            oracle.blockhash(blockHeight) == blockHash,
            "Transaction not dispatched from origin chain"
        );

        return true;
    }

    function _extractBlockInfo(
        bytes calldata _messageBody
    ) internal returns (uint256 hash, uint256 height) {
        require(_messageBody.length >= 64, "Invalid message body");

        (hash, height) = abi.decode(_messageBody[:64], (uint256, uint256));
    }
}
