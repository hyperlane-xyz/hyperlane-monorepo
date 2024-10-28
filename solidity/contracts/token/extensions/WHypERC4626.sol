// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {HypERC4626} from "./HypERC4626.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

/**
 * @title WHypERC4626
 * @author Abacus Works
 * @notice A wrapper for HypERC4626 that allows for wrapping and unwrapping of underlying rebasing tokens
 */
contract WHypERC4626 is ERC20, PackageVersioned {
    HypERC4626 public immutable underlying;

    constructor(
        HypERC4626 _underlying,
        string memory name,
        string memory symbol
    ) ERC20(name, symbol) {
        underlying = _underlying;
    }

    /*
     * @notice Wraps an amount of underlying tokens into wrapped tokens
     * @param _underlyingAmount The amount of underlying tokens to wrap
     * @return The amount of wrapped tokens
     */
    function wrap(uint256 _underlyingAmount) external returns (uint256) {
        require(
            _underlyingAmount > 0,
            "WHypERC4626: wrap amount must be greater than 0"
        );
        uint256 wrappedAmount = underlying.assetsToShares(_underlyingAmount);
        _mint(msg.sender, wrappedAmount);
        underlying.transferFrom(msg.sender, address(this), _underlyingAmount);
        return wrappedAmount;
    }

    /*
     * @notice Unwraps an amount of wrapped tokens into underlying tokens
     * @param _wrappedAmount The amount of wrapped tokens to unwrap
     * @return The amount of underlying tokens
     */
    function unwrap(uint256 _wrappedAmount) external returns (uint256) {
        require(
            _wrappedAmount > 0,
            "WHypERC4626: unwrap amount must be greater than 0"
        );
        uint256 underlyingAmount = underlying.sharesToAssets(_wrappedAmount);
        _burn(msg.sender, _wrappedAmount);
        underlying.transfer(msg.sender, underlyingAmount);
        return underlyingAmount;
    }

    /*
     * @notice Gets the amount of wrapped tokens for a given amount of underlying tokens
     * @param _underlyingAmount The amount of underlying tokens
     * @return The amount of wrapped tokens
     */
    function getWrappedAmount(
        uint256 _underlyingAmount
    ) external view returns (uint256) {
        return underlying.assetsToShares(_underlyingAmount);
    }

    /*
     * @notice Gets the amount of underlying tokens for a given amount of wrapped tokens
     * @param _wrappedAmount The amount of wrapped tokens
     * @return The amount of underlying tokens
     */
    function getUnderlyingAmount(
        uint256 _wrappedAmount
    ) external view returns (uint256) {
        return underlying.sharesToAssets(_wrappedAmount);
    }

    /*
     * @notice Gets the amount of wrapped tokens for 1 unit of underlying tokens
     * @return The amount of wrapped tokens
     */
    function wrappedPerUnderlying() external view returns (uint256) {
        return underlying.assetsToShares(1 * 10 ** underlying.decimals());
    }

    /*
     * @notice Gets the amount of underlying tokens for 1 unit of wrapped tokens
     * @return The amount of underlying tokens
     */
    function underlyingPerWrapped() external view returns (uint256) {
        return underlying.sharesToAssets(1 * 10 ** decimals());
    }

    /*
     * @notice Gets the decimals of the wrapped token
     * @return The decimals of the wrapped token
     */
    function decimals() public view override returns (uint8) {
        return underlying.decimals();
    }
}
