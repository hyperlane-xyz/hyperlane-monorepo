// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {HypXERC20} from "./HypXERC20.sol";

/// @notice Warp adapter for existing VeruLink wrapped tokens.
/// @dev Requires the token's MINTER_ROLE; outbound burns require user allowance.
contract HypVeruLink is HypXERC20 {
    constructor(
        address _token,
        uint256 _scaleNumerator,
        uint256 _scaleDenominator,
        address _mailbox
    ) HypXERC20(_token, _scaleNumerator, _scaleDenominator, _mailbox) {}

    /// @inheritdoc HypXERC20
    function _transferFromSender(uint256 _amountOrId) internal override {
        ERC20Burnable(address(wrappedToken)).burnFrom(msg.sender, _amountOrId);
    }
}
