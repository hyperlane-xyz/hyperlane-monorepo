// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IDelegationManager} from "../../interfaces/avs/vendored/IDelegationManager.sol";
import {IStrategy} from "../../interfaces/avs/vendored/IStrategy.sol";

contract TestDelegationManager is IDelegationManager {
    mapping(address => bool) public isOperator;
    mapping(address => mapping(IStrategy => uint256)) public operatorShares;

    function registerAsOperator(
        OperatorDetails calldata registeringOperatorDetails,
        string calldata metadataURI
    ) external {}

    function setIsOperator(
        address operator,
        bool _isOperatorReturnValue
    ) external {
        isOperator[operator] = _isOperatorReturnValue;
    }

    function getOperatorShares(
        address operator,
        IStrategy[] memory strategies
    ) public view returns (uint256[] memory) {
        uint256[] memory shares = new uint256[](strategies.length);
        for (uint256 i = 0; i < strategies.length; ++i) {
            shares[i] = operatorShares[operator][strategies[i]];
        }
        return shares;
    }
}
