// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

// ============ Internal Imports ============
import "../../../lib/fx-portal/contracts/lib/RLPReader.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../libs/Message.sol";

interface IBlockHashOracle {
    function origin() external view returns (uint32);
    function blockHash(uint256 height) external view returns (uint256 hash);
}

contract BlockHashIsm is IInterchainSecurityModule {
    using RLPReader for bytes;
    using RLPReader for RLPReader.RLPItem;

    // module type for the ISM
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.BLOCKHASH);

    IBlockHashOracle public immutable oracle;
    address public immutable expectedOriginMailbox;

    constructor(address _oracle, address _expectedOriginMailbox) {
        oracle = IBlockHashOracle(_oracle);
        expectedOriginMailbox = _expectedOriginMailbox;
    }

    function verify(
        bytes calldata metadata,
        bytes calldata message
    ) external view override returns (bool) {
        // Metadata = abi.encode(blockHeight, rlpEncodedHeader).
        (uint256 blockHeight, bytes memory rlpHeader) = abi.decode(
            metadata,
            (uint256, bytes)
        );

        // Compute hash of the RLP header.
        bytes32 computedHeaderHash = keccak256(rlpHeader);

        // Get expected hash from oracle.
        uint256 expectedHash = oracle.blockHash(blockHeight);

        if (bytes32(expectedHash) != computedHeaderHash) {
            return false;
        }

        // Validate that message.origin matches oracle.origin.
        if (Message.origin(message) != oracle.origin()) {
            return false;
        }

        // Validate that message.originMailbox matches expected origin mailbox.
        if (
            Message.sender(message) !=
            bytes32(uint256(uint160(expectedOriginMailbox)))
        ) {
            return false;
        }

        return true;
    }
}
