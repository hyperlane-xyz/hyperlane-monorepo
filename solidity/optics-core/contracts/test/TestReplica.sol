// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import "../Replica.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

contract TestReplica is Replica {
    using TypedMemView for bytes;
    using TypedMemView for bytes29;
    using Message for bytes29;

    // Mock state variables
    struct MockMessage {
      uint32 homeDomain;
      bytes32 sender;
      bytes32 recipient;
      bytes messageBody;
    }
    MockMessage[] public queuedMessages;

    constructor(
        uint32 _localDomain,
        uint256,
        uint256
    ) Replica(_localDomain, 850_000, 15_000) {} // solhint-disable-line no-empty-blocks

    function setFailed() public {
        _setFailed();
    }

    function setUpdater(address _updater) external {
        updater = _updater;
    }

    function setRemoteDomain(uint32 _remoteDomain) external {
        remoteDomain = _remoteDomain;
    }

    function setMessagePending(bytes memory _message) external {
        bytes29 _m = _message.ref(0);
        messages[_m.keccak()] = MessageStatus.Proven;
    }

    function setCommittedRoot(bytes32 _newRoot) external {
        committedRoot = _newRoot;
        confirmAt[_newRoot] = 1;
    }

    function timestamp() external view returns (uint256) {
        return block.timestamp;
    }

    function testHomeDomainHash() external view returns (bytes32) {
        return homeDomainHash();
    }

    function testBranchRoot(
        bytes32 leaf,
        bytes32[32] calldata proof,
        uint256 index
    ) external pure returns (bytes32) {
        return MerkleLib.branchRoot(leaf, proof, index);
    }

    function testProcess(bytes memory _message)
        external
        returns (bool _success)
    {
        (_success) = process(_message);
    }

    function handleMessageFromMockHome(
      uint32 homeDomain,
      bytes32 sender,
      bytes32 recipient,
      bytes memory messageBody
    ) external {
      MockMessage memory newMessage = MockMessage({
        homeDomain: homeDomain,
        sender: sender,
        recipient: recipient,
        messageBody: messageBody
      });
      queuedMessages.push(newMessage);
    }

    function flushMessages() external {
      for (uint i=0;i<queuedMessages.length;i++) {
        MockMessage storage message = queuedMessages[i];
        bool _success;
        address _recipient = TypeCasts.bytes32ToAddress(message.recipient);
        // set up for assembly call
        uint256 _toCopy;
        uint256 _maxCopy = 256;
        uint256 _gas = PROCESS_GAS;
        // allocate memory for returndata
        bytes memory _returnData = new bytes(_maxCopy);
        bytes memory _calldata = abi.encodeWithSignature(
            "handle(uint32,bytes32,bytes)",
            message.homeDomain,
            message.sender,
            message.messageBody
        );
        // dispatch message to recipient
        // by assembly calling "handle" function
        // we call via assembly to avoid memcopying a very large returndata
        // returned by a malicious contract
        assembly {
            _success := call(
                _gas, // gas
                _recipient, // recipient
                0, // ether value
                add(_calldata, 0x20), // inloc
                mload(_calldata), // inlen
                0, // outloc
                0 // outlen
            )
            // limit our copy to 256 bytes
            _toCopy := returndatasize()
            if gt(_toCopy, _maxCopy) {
                _toCopy := _maxCopy
            }
            // Store the length of the copied bytes
            mstore(_returnData, _toCopy)
            // copy the bytes from returndata[0:_toCopy]
            returndatacopy(add(_returnData, 0x20), 0, _toCopy)
        }
      }
    }

    function getRevertMsg(bytes memory _res)
        internal
        view
        returns (string memory)
    {
        bytes29 _view = _res.ref(0);

        // If the _res length is less than 68, then the transaction failed
        // silently (without a revert message)
        if (_view.len() < 68) return "Transaction reverted silently";

        // Remove the selector which is the first 4 bytes
        bytes memory _revertData = _view.slice(4, _res.length - 4, 0).clone();

        // All that remains is the revert string
        return abi.decode(_revertData, (string));
    }
}
