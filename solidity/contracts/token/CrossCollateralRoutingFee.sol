// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ICrossCollateralFee} from "./interfaces/ICrossCollateralFee.sol";
import {ITokenFee, Quote} from "../interfaces/ITokenBridge.sol";
import {PackageVersioned} from "../PackageVersioned.sol";
import {FeeType} from "./fees/BaseFee.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title CrossCollateralRoutingFee
 * @notice Routes fee lookups by destination + target router. Delegates to
 * existing ITokenFee (3-param) fee contracts (LinearFee, ProgressiveFee, etc.).
 * @dev This contract assumes standard ERC20 behavior for fee balances and
 * transfers. Rebasing, fee-on-transfer, and ERC777 tokens are not supported
 * for deterministic fee accounting.
 */
// solhint-disable-next-line hyperlane/enumerable-domain-mapping
contract CrossCollateralRoutingFee is
    ICrossCollateralFee,
    ITokenFee,
    Ownable,
    PackageVersioned
{
    using SafeERC20 for IERC20;

    /// @notice Sentinel key for destination-level default fee contracts.
    bytes32 public constant DEFAULT_ROUTER =
        keccak256("RoutingFee.DEFAULT_ROUTER");

    /// @notice Per destination + per target router → fee contract.
    /// Destination defaults use DEFAULT_ROUTER as targetRouter.
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

    function setCrossCollateralRouterFeeContracts(
        uint32[] calldata destinations,
        bytes32[] calldata targetRouters,
        address[] calldata _feeContracts
    ) external onlyOwner {
        require(
            destinations.length == targetRouters.length &&
                destinations.length == _feeContracts.length,
            "CCRF: length mismatch"
        );

        for (uint256 i = 0; i < destinations.length; i++) {
            feeContracts[destinations[i]][targetRouters[i]] = _feeContracts[i];
            emit FeeContractSet(
                destinations[i],
                targetRouters[i],
                _feeContracts[i]
            );
        }
    }

    function claim(address beneficiary, address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(beneficiary, balance);
    }

    function feeType() external pure returns (FeeType) {
        return FeeType.CROSS_COLLATERAL_ROUTING;
    }

    /**
     * @inheritdoc ITokenFee
     * @dev Quotes destination-level fee using DEFAULT_ROUTER sentinel.
     */
    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view override returns (Quote[] memory) {
        return
            _quoteTransferRemote(
                _destination,
                _recipient,
                _amount,
                DEFAULT_ROUTER
            );
    }

    /**
     * @inheritdoc ICrossCollateralFee
     * @dev Routes: specific router → destination default (DEFAULT_ROUTER).
     */
    function quoteTransferRemoteTo(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes32 _targetRouter
    ) external view override returns (Quote[] memory) {
        return
            _quoteTransferRemote(
                _destination,
                _recipient,
                _amount,
                _targetRouter
            );
    }

    function _quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes32 _targetRouter
    ) internal view returns (Quote[] memory) {
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
        address destFee = feeContracts[_destination][DEFAULT_ROUTER];
        if (destFee != address(0)) {
            return
                ITokenFee(destFee).quoteTransferRemote(
                    _destination,
                    _recipient,
                    _amount
                );
        }
        // 3. No fee configured for router or destination default
        revert("CCRF: no fee contract");
    }
}
