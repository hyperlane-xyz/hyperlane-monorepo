// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IMultiCollateralFee} from "./interfaces/IMultiCollateralFee.sol";
import {ITokenFee, Quote} from "@hyperlane-xyz/core/interfaces/ITokenBridge.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MultiCollateralRoutingFee
 * @notice Routes fee lookups by destination + target router. Delegates to
 * existing ITokenFee (3-param) fee contracts (LinearFee, ProgressiveFee, etc.).
 */
contract MultiCollateralRoutingFee is IMultiCollateralFee, Ownable {
    /// @notice Per destination + per target router → fee contract.
    /// Default (destination-only) uses bytes32(0) sentinel.
    mapping(uint32 dest => mapping(bytes32 targetRouter => address feeContract))
        public feeContracts;

    event FeeContractSet(
        uint32 destination,
        bytes32 targetRouter,
        address feeContract
    );

    constructor(address _owner) Ownable() {
        _transferOwnership(_owner);
    }

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
     * @inheritdoc IMultiCollateralFee
     * @dev Routes: specific router → default (bytes32(0)) → empty quotes (0 fee).
     */
    function quoteTransferRemoteTo(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes32 _targetRouter
    ) external view override returns (Quote[] memory) {
        // 1. Check per-router fee
        address routerFee = feeContracts[_destination][_targetRouter];
        if (routerFee != address(0)) {
            return
                ITokenFee(routerFee).quoteTransferRemote(
                    _destination,
                    _recipient,
                    _amount
                );
        }
        // 2. Fallback to destination default
        address destFee = feeContracts[_destination][bytes32(0)];
        if (destFee != address(0)) {
            return
                ITokenFee(destFee).quoteTransferRemote(
                    _destination,
                    _recipient,
                    _amount
                );
        }
        // 3. No fee configured → empty quotes
        return new Quote[](0);
    }
}
