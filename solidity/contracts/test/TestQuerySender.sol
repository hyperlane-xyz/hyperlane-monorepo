// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Call, IInterchainQueryRouter} from "../../interfaces/IInterchainQueryRouter.sol";

contract TestQuerySender {
    IInterchainQueryRouter queryRouter;

    address public lastAddressResult;
    uint256 public lastUint256Result;
    bytes32 public lastBytes32Result;

    constructor(address _queryRouterAddress) {
        queryRouter = IInterchainQueryRouter(_queryRouterAddress);
    }

    function queryAddress(
        uint32 _destinationDomain,
        address _target,
        bytes calldata _targetData
    ) public {
        queryRouter.query(
            _destinationDomain,
            Call({to: _target, data: _targetData}),
            abi.encodePacked(this.handleQueryAddressResult.selector)
        );
    }

    function handleQueryAddressResult(address _result) public {
        lastAddressResult = _result;
    }

    function queryUint256(
        uint32 _destinationDomain,
        address _target,
        bytes calldata _targetData
    ) public {
        queryRouter.query(
            _destinationDomain,
            Call({to: _target, data: _targetData}),
            abi.encodePacked(this.handleQueryUint256Result.selector)
        );
    }

    function handleQueryUint256Result(uint256 _result) public {
        lastUint256Result = _result;
    }

    function queryBytes32(
        uint32 _destinationDomain,
        address _target,
        bytes calldata _targetData
    ) public {
        queryRouter.query(
            _destinationDomain,
            Call({to: _target, data: _targetData}),
            abi.encodePacked(this.handleQueryBytes32Result.selector)
        );
    }

    function handleQueryBytes32Result(bytes32 _result) public {
        lastBytes32Result = _result;
    }
}
