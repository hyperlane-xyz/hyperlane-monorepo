// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

contract MockCrossCollateralRoutingFee {
    enum FeeType {
        ZERO,
        LINEAR,
        REGRESSIVE,
        PROGRESSIVE,
        ROUTING,
        CROSS_COLLATERAL_ROUTING
    }

    bytes32 public constant DEFAULT_ROUTER =
        keccak256(bytes("RoutingFee.DEFAULT_ROUTER"));

    address public owner;

    mapping(uint32 destination => mapping(bytes32 router => address feeContract))
        public feeContracts;

    constructor(address _owner) {
        owner = _owner;
    }

    function feeType() external pure returns (FeeType) {
        return FeeType.CROSS_COLLATERAL_ROUTING;
    }

    function setCrossCollateralRouterFeeContracts(
        uint32[] calldata _destinations,
        bytes32[] calldata _routers,
        address[] calldata _feeContracts
    ) external {
        require(
            _destinations.length == _routers.length &&
                _routers.length == _feeContracts.length,
            "length mismatch"
        );

        for (uint256 i = 0; i < _destinations.length; i++) {
            feeContracts[_destinations[i]][_routers[i]] = _feeContracts[i];
        }
    }
}
