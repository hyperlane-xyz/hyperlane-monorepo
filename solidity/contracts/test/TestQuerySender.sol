// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {InterchainQueryRouter} from "../middleware/InterchainQueryRouter.sol";
import {CallLib} from "../middleware/libs/Call.sol";

contract TestQuerySender {
    InterchainQueryRouter queryRouter;

    address public lastAddressResult;
    uint256 public lastUint256Result;
    bytes32 public lastBytes32Result;

    event ReceivedAddressResult(address result);
    event ReceivedUint256Result(uint256 result);
    event ReceivedBytes32Result(bytes32 result);

    function initialize(address _queryRouterAddress) external {
        queryRouter = InterchainQueryRouter(_queryRouterAddress);
    }

    function queryAddress(
        uint32 _destinationDomain,
        address _target,
        bytes calldata _targetData,
        uint256 _gasAmount
    ) external payable {
        queryAndPayFor(
            _destinationDomain,
            _target,
            _targetData,
            this.handleQueryAddressResult.selector,
            _gasAmount
        );
    }

    function handleQueryAddressResult(address _result) external {
        emit ReceivedAddressResult(_result);
        lastAddressResult = _result;
    }

    function queryUint256(
        uint32 _destinationDomain,
        address _target,
        bytes calldata _targetData,
        uint256 _gasAmount
    ) external payable {
        queryAndPayFor(
            _destinationDomain,
            _target,
            _targetData,
            this.handleQueryUint256Result.selector,
            _gasAmount
        );
    }

    function handleQueryUint256Result(uint256 _result) external {
        emit ReceivedUint256Result(_result);
        lastUint256Result = _result;
    }

    function queryBytes32(
        uint32 _destinationDomain,
        address _target,
        bytes calldata _targetData,
        uint256 _gasAmount
    ) external payable {
        queryAndPayFor(
            _destinationDomain,
            _target,
            _targetData,
            this.handleQueryBytes32Result.selector,
            _gasAmount
        );
    }

    function handleQueryBytes32Result(bytes32 _result) external {
        emit ReceivedBytes32Result(_result);
        lastBytes32Result = _result;
    }

    function queryAndPayFor(
        uint32 _destinationDomain,
        address _target,
        bytes calldata _targetData,
        bytes4 _callbackSelector,
        uint256 /*_gasAmount*/
    ) internal {
        queryRouter.query(
            _destinationDomain,
            _target,
            _targetData,
            abi.encodePacked(_callbackSelector)
        );
    }
}
