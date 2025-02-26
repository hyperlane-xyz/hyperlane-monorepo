// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;
import {PolygonZkevmIsm} from "../../contracts/isms/hook/PolygonZkevmIsm.sol";

contract MockPolygonZkevmBridge {
    PolygonZkevmIsm public ism;
    bytes public returnData;

    function setIsm(PolygonZkevmIsm _ism) public {
        ism = _ism;
    }

    function setReturnData(bytes memory _returnData) public {
        returnData = _returnData;
    }

    function bridgeMessage(
        uint32,
        address,
        bool,
        bytes calldata
    ) external payable {}

    function claimMessage(
        bytes32[32] calldata,
        uint32,
        bytes32,
        bytes32,
        uint32,
        address,
        uint32,
        address,
        uint256,
        bytes calldata
    ) external payable {
        ism.onMessageReceived(address(0x1), uint32(0), returnData);
    }
}
