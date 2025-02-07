// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

contract MockArbSys {
    event L2ToL1Tx(
        address caller,
        address indexed destination,
        uint256 indexed hash,
        uint256 indexed position,
        uint256 arbBlockNum,
        uint256 ethBlockNum,
        uint256 timestamp,
        uint256 callvalue,
        bytes data
    );

    function sendTxToL1(
        address destination,
        bytes calldata data
    ) external payable returns (uint256) {
        emit L2ToL1Tx(
            msg.sender,
            destination,
            uint256(keccak256(data)),
            42,
            block.number * 10,
            block.number,
            block.timestamp,
            msg.value,
            data
        );
        return 0;
    }
}

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

    function bridge() external view returns (address) {
        return address(this);
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
