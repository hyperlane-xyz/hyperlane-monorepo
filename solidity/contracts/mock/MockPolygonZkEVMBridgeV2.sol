// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {PolygonZkevmV2Ism} from "../isms/hook/PolygonZkevmV2Ism.sol";
import "forge-std/console.sol";

contract MockPolygonZkEVMBridgeV2 {
    PolygonZkevmV2Ism public ism;
    bytes public returnData;

    function setIsm(PolygonZkevmV2Ism _ism) external {
        ism = _ism;
    }

    function setReturnData(bytes memory _returnData) external {
        returnData = _returnData;
    }

    function claimMessage(
        bytes32[32] calldata smtProofLocalExitRoot,
        bytes32[32] calldata smtProofRollupExitRoot,
        uint256 globalIndex,
        bytes32 mainnetExitRoot,
        bytes32 rollupExitRoot,
        uint32 originNetwork,
        address originTokenAddress,
        uint32 destinationNetwork,
        address destinationAddress,
        uint256 amount,
        bytes calldata metadata
    ) external pure returns (bytes memory) {
        return
            abi.encode(
                smtProofLocalExitRoot,
                smtProofRollupExitRoot,
                globalIndex,
                mainnetExitRoot,
                rollupExitRoot,
                originNetwork,
                originTokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            );
    }

    function bridgeMessage(
        uint32,
        address,
        bool,
        bytes calldata
    ) external payable {
        return;
    }
}
