// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {ITokenFee, Quote} from "../../interfaces/ITokenBridge.sol";
import {BaseFee, FeeType} from "./BaseFee.sol";

/**
 * @title RoutingFee
 * @notice Implements ITokenFee, allowing per-destination fee contracts. Returns 0 fee for destinations not configured.
 */
contract RoutingFee is BaseFee {
    constructor(
        address _token,
        address _owner
    ) BaseFee(_token, type(uint256).max, type(uint256).max, _owner) {}

    mapping(uint32 destination => mapping(bytes32 targetRouter => address feeContract))
        public feeContracts;

    event FeeContractSet(
        uint32 destination,
        bytes32 targetRouter,
        address feeContract
    );

    /**
     * @notice Sets the default fee contract for a destination (sentinel bytes32(0)).
     */
    function setFeeContract(
        uint32 destination,
        address feeContract
    ) external onlyOwner {
        feeContracts[destination][bytes32(0)] = feeContract;
        emit FeeContractSet(destination, bytes32(0), feeContract);
    }

    /**
     * @notice Sets the fee contract for a specific destination + target router.
     */
    function setRouterFeeContract(
        uint32 destination,
        bytes32 targetRouter,
        address feeContract
    ) external onlyOwner {
        feeContracts[destination][targetRouter] = feeContract;
        emit FeeContractSet(destination, targetRouter, feeContract);
    }

    /**
     * @inheritdoc ITokenFee
     * @dev Looks up feeContracts[dest][bytes32(0)] (default sentinel).
     */
    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view override returns (Quote[] memory quotes) {
        address feeContract = feeContracts[_destination][bytes32(0)];
        if (feeContract != address(0)) {
            return
                ITokenFee(feeContract).quoteTransferRemote(
                    _destination,
                    _recipient,
                    _amount
                );
        }
        quotes = new Quote[](0);
    }

    /**
     * @dev Routes: specific router → default (bytes32(0)).
     */
    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes32 _targetRouter
    ) external view override returns (Quote[] memory) {
        address routerFee = feeContracts[_destination][_targetRouter];
        if (routerFee != address(0)) {
            return
                ITokenFee(routerFee).quoteTransferRemote(
                    _destination,
                    _recipient,
                    _amount,
                    _targetRouter
                );
        }
        // Fall back to default sentinel
        return this.quoteTransferRemote(_destination, _recipient, _amount);
    }

    function feeType() external pure override returns (FeeType) {
        return FeeType.ROUTING;
    }
}
