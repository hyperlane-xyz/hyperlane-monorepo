// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {MerkleTreeManager} from "@celo-org/optics-sol/contracts/Merkle.sol";

import {Message} from "@celo-org/optics-sol/libs/Message.sol";
import {MerkleLib} from "@celo-org/optics-sol/libs/Merkle.sol";

// We reproduce a significant amount of logic from `Home` to ensure that
// calling dispatch here is AT LEAST AS EXPENSIVE as calling it on Home
contract MockCore is MerkleTreeManager {
    using MerkleLib for MerkleLib.Tree;

    uint256 public constant MAX_MESSAGE_BODY_BYTES = 2 * 2**10;

    event Dispatch(
        bytes32 indexed messageHash,
        uint256 indexed leafIndex,
        uint64 indexed destinationAndNonce,
        bytes32 latestSnapshotRoot,
        bytes message
    );

    mapping(uint32 => uint32) public nonces;

    function localDomain() public pure returns (uint32) {
        return 5;
    }

    function home() external view returns (address) {
        return address(this);
    }

    // We reproduce the logic here to simulate
    function dispatch(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        bytes calldata _messageBody
    ) external {
        require(_messageBody.length <= MAX_MESSAGE_BODY_BYTES, "msg too long");
        // get the next nonce for the destination domain, then increment it
        uint32 _nonce = nonces[_destinationDomain];
        nonces[_destinationDomain] = _nonce + 1;
        // format the message into packed bytes
        bytes memory _message = Message.formatMessage(
            localDomain(),
            bytes32(uint256(uint160(msg.sender))),
            _nonce,
            _destinationDomain,
            _recipientAddress,
            _messageBody
        );
        // insert the hashed message into the Merkle tree
        bytes32 _messageHash = keccak256(_message);
        tree.insert(_messageHash);
        // Emit Dispatch event with message information
        // note: leafIndex is count() - 1 since new leaf has already been inserted
        emit Dispatch(
            _messageHash,
            count() - 1,
            _destinationAndNonce(_destinationDomain, _nonce),
            bytes32(0),
            _message
        );
    }

    function isReplica(address) public pure returns (bool) {
        return true;
    }

    function _destinationAndNonce(uint32 _destination, uint32 _nonce)
        internal
        pure
        returns (uint64)
    {
        return (uint64(_destination) << 32) | _nonce;
    }
}
