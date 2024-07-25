// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

contract MockArbBridge {
    error BridgeCallFailed();

    address public activeOutbox;
    address public l2ToL1Sender;

    constructor() {
        activeOutbox = address(this);
    }

    function setL2ToL1Sender(address _sender) external {
        l2ToL1Sender = _sender;
    }

    function executeTransaction(
        bytes32[] calldata /*proof*/,
        uint256 /*index*/,
        address /*l2Sender*/,
        address to,
        uint256 /*l2Block*/,
        uint256 /*l1Block*/,
        uint256 /*timestamp*/,
        uint256 value,
        bytes calldata data
    ) external payable {
        (bool success, bytes memory returndata) = to.call{value: value}(data);
        if (!success) {
            if (returndata.length > 0) {
                // solhint-disable-next-line no-inline-assembly
                assembly {
                    let returndata_size := mload(returndata)
                    revert(add(32, returndata), returndata_size)
                }
            } else {
                revert BridgeCallFailed();
            }
        }
    }
}
