// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

/**
  MockHome is a contract that is intended to use in testing scenarios without a full-blown optics deployment. MockReplicas can be connected to this MockHome directly. Messages are still considered to be async
 */

import "@celo-org/optics-sol/contracts/Replica.sol";
import {TypeCasts} from "@celo-org/optics-sol/contracts/XAppConnectionManager.sol";
import {Common} from "@celo-org/optics-sol/contracts/Common.sol";

contract MockReplica is Common {
    // ============ Immutables ============

    // Minimum gas for message processing
    uint256 public immutable PROCESS_GAS = 850_000;
    // Reserved gas (to ensure tx completes in case message processing runs out)
    uint256 public immutable RESERVE_GAS = 15_000;

    // Mock state variables
    struct MockMessage {
      uint32 homeDomain;
      bytes32 sender;
      bytes32 recipient;
      bytes messageBody;
    }
    MockMessage[] public queuedMessages;

    constructor(uint32 _localDomain) Common(_localDomain) {} // solhint-disable-line no-empty-blocks

    function homeDomainHash() public view override returns (bytes32) {
        return _homeDomainHash(localDomain);
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

    // address _recipient = _m.recipientAddress();
    //     // set up for assembly call
    //     uint256 _toCopy;
    //     uint256 _maxCopy = 256;
    //     uint256 _gas = PROCESS_GAS;
    //     // allocate memory for returndata
    //     bytes memory _returnData = new bytes(_maxCopy);
    //     bytes memory _calldata = abi.encodeWithSignature(
    //         "handle(uint32,bytes32,bytes)",
    //         _m.origin(),
    //         _m.sender(),
    //         _m.body().clone()
    //     );
    //     // dispatch message to recipient
    //     // by assembly calling "handle" function
    //     // we call via assembly to avoid memcopying a very large returndata
    //     // returned by a malicious contract
    //     assembly {
    //         _success := call(
    //             _gas, // gas
    //             _recipient, // recipient
    //             0, // ether value
    //             add(_calldata, 0x20), // inloc
    //             mload(_calldata), // inlen
    //             0, // outloc
    //             0 // outlen
    //         )
    //         // limit our copy to 256 bytes
    //         _toCopy := returndatasize()
    //         if gt(_toCopy, _maxCopy) {
    //             _toCopy := _maxCopy
    //         }
    //         // Store the length of the copied bytes
    //         mstore(_returnData, _toCopy)
    //         // copy the bytes from returndata[0:_toCopy]
    //         returndatacopy(add(_returnData, 0x20), 0, _toCopy)
    //     }

    function _fail() internal override {
        // set contract to FAILED
        _setFailed();
    }
}
