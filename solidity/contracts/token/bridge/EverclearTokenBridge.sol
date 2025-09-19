// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {ITokenBridge, Quote} from "../../interfaces/ITokenBridge.sol";
import {HypERC20Collateral} from "../HypERC20Collateral.sol";
import {TokenRouter} from "../libs/TokenRouter.sol";
import {IEverclearAdapter, IEverclear, IEverclearSpoke} from "../../interfaces/IEverclearAdapter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";
import {IWETH} from "../interfaces/IWETH.sol";
import {TokenMessage} from "../libs/TokenMessage.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {OutputAssetInfo, EverclearBridge} from "../libs/EverclearBridge.sol";
import {ERC20Collateral} from "../libs/TokenCollateral.sol";

/**
 * @title EverclearTokenBridge
 * @author Hyperlane Team
 * @notice A token bridge that integrates with Everclear's intent-based architecture
 * @dev Extends HypERC20Collateral to provide cross-chain token transfers via Everclear's intent system
 */
contract EverclearTokenBridge is EverclearBridge {
    using ERC20Collateral for IERC20;

    /**
     * @notice Constructor to initialize the Everclear token bridge
     * @param _everclearAdapter The address of the Everclear adapter contract
     */
    constructor(
        address _erc20,
        uint256 _scale,
        address _mailbox,
        IEverclearAdapter _everclearAdapter
    ) EverclearBridge(_everclearAdapter, IERC20(_erc20), _scale, _mailbox) {}

    // ============ TokenRouter overrides ============
    function token() public view override returns (address) {
        return address(wrappedToken);
    }

    function _transferFromSender(uint256 _amount) internal override {
        wrappedToken._transferFromSender(_amount);
    }

    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal override {
        wrappedToken._transferTo(_recipient, _amount);
    }
}
