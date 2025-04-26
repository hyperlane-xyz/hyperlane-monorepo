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

    function addressToBytes32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function verify(
        bytes calldata metadata,
        bytes calldata message
    ) external view override returns (bool) {
        // Decode to calldata for better gas efficiency.
        uint256 blockHeight;
        assembly {
            blockHeight := calldataload(metadata.offset)
        }
        bytes calldata rlpHeader = metadata[32:];

        // Cache oracle to avoid multiple external calls.
        IBlockHashOracle _oracle = oracle;

        // Validate origin chain ID and originMailbox first
        if (Message.origin(message) != _oracle.origin()) return false;

        // Validate that message.originMailbox matches expected origin mailbox.
        if (Message.sender(message) != addressToBytes32(expectedOriginMailbox))
            return false;

        // Only hash header if origin checks pass.
        bytes32 computedHeaderHash = keccak256(rlpHeader);
        // Get expected hash from oracle.
        uint256 expectedHash = _oracle.blockHash(blockHeight);

        return bytes32(expectedHash) == computedHeaderHash;
    }
}
