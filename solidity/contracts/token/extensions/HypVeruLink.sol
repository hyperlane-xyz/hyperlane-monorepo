// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IVeruLinkToken} from "../interfaces/IVeruLinkToken.sol";
import {TokenRouter} from "../libs/TokenRouter.sol";

/// @notice Warp adapter for existing VeruLink wrapped tokens.
/// @dev Requires the token's MINTER_ROLE; outbound burns require user allowance.
contract HypVeruLink is TokenRouter {
    IVeruLinkToken public immutable wrappedToken;

    constructor(
        address _token,
        uint256 _scaleNumerator,
        uint256 _scaleDenominator,
        address _mailbox
    ) TokenRouter(_scaleNumerator, _scaleDenominator, _mailbox) {
        wrappedToken = IVeruLinkToken(_token);
        _disableInitializers();
    }

    function initialize(
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) public initializer {
        _MailboxClient_initialize(_hook, _interchainSecurityModule, _owner);
    }

    // ============ TokenRouter overrides ============

    function token() public view override returns (address) {
        return address(wrappedToken);
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Token fees are not supported for VeruLink tokens. Transfers and quotes revert until a configured fee recipient is removed.
     */
    function feeRecipient() public view override returns (address) {
        require(
            super.feeRecipient() == address(0),
            "TokenRouter: token fees unsupported"
        );
        return address(0);
    }

    /// @inheritdoc TokenRouter
    function _transferFromSender(uint256 _amountOrId) internal override {
        wrappedToken.burnFrom(msg.sender, _amountOrId);
    }

    /// @inheritdoc TokenRouter
    function _transferTo(
        address _recipient,
        uint256 _amountOrId
    ) internal override {
        wrappedToken.mint(_recipient, _amountOrId);
    }
}
