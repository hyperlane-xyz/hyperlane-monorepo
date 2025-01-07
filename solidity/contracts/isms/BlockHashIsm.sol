// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../libs/Message.sol";
import {Mailbox} from "../Mailbox.sol";
import {PackageVersioned} from "contracts/PackageVersioned.sol";
import {IBlockHashOracle} from "../../contracts/interfaces/IBlockHashOracle.sol";

// ==================== External Imports ====================
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import "solidity-rlp/contracts/RLPReader.sol";

// NOTE: Relayers are untrusted but BlockHashOracle is trusted.
contract BlockHashIsm is IInterchainSecurityModule, PackageVersioned {
    using Message for bytes;
    using RLPReader for bytes;
    using RLPReader for RLPReader.Iterator;
    using RLPReader for RLPReader.RLPItem;

    uint8 public immutable moduleType = uint8(Types.NULL);
    Mailbox public immutable mailbox;
    IBlockHashOracle public immutable oracle;

    constructor(address _mailbox, address _oracle) {
        require(Address.isContract(_mailbox), "BlockHashIsm: invalid mailbox");
        require(Address.isContract(_oracle), "BlockHashIsm: invalid oracle");
        oracle = IBlockHashOracle(_oracle);
        mailbox = Mailbox(_mailbox);
    }

    // Message is a RLP-encoded block.
    // Verified by:
    // 1. Checking the origin against the oracle.
    // 2. Hashhing the RLP-encoding of the block and checking against the oracle.
    function verify(
        bytes calldata,
        bytes calldata _message
    ) external view returns (bool) {
        if (_message.origin() != oracle.origin()) {
            return false;
        }
        uint256 _height = heightOfBlock(_message.body());
        uint256 _hash = hashOfBlock(_message.body());
        return oracle.blockhash(_height) == _hash;
    }

    function heightOfBlock(
        bytes memory _messageBody
    ) internal pure returns (uint) {
        RLPReader.RLPItem[] memory _block = _messageBody.toRlpItem().toList();
        RLPReader.RLPItem[] memory _body = _block[4]
            .toBytes()
            .toRlpItem()
            .toList();
        RLPReader.RLPItem[] memory _execution_payload = _body[9]
            .toBytes()
            .toRlpItem()
            .toList();
        return _execution_payload[6].toUint();
    }

    function hashOfBlock(
        bytes memory _block
    ) internal pure returns (uint256 _hash) {
        _hash = uint256(keccak256(_block));
    }
}
