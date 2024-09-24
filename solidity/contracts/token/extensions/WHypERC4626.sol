// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {HypERC4626} from "./HypERC4626.sol";

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

contract WHypERC4626 is ERC20 {
    HypERC4626 public immutable underlying;

    constructor(
        HypERC4626 _underlying,
        string memory name,
        string memory symbol
    ) ERC20(name, symbol) {
        underlying = _underlying;
    }

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

    function getWrappedAmount(
        uint256 _underlyingAmount
    ) external view returns (uint256) {
        return underlying.assetsToShares(_underlyingAmount);
    }

    function getUnderlyingAmount(
        uint256 _wrappedAmount
    ) external view returns (uint256) {
        return underlying.sharesToAssets(_wrappedAmount);
    }

    function wrappedPerUnderlying() external view returns (uint256) {
        return underlying.assetsToShares(1 * 10 ** underlying.decimals());
    }

    function underlyingPerWrapped() external view returns (uint256) {
        return underlying.sharesToAssets(1 * 10 ** decimals());
    }

    function decimals() public view override returns (uint8) {
        return underlying.decimals();
    }
}
