// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IFiatToken} from "../interfaces/IFiatToken.sol";
import {HypERC20Collateral} from "../HypERC20Collateral.sol";
import {TokenRouter} from "../libs/TokenRouter.sol";
import {ERC20Collateral} from "../libs/TokenCollateral.sol";
import {LpCollateralRouterStorage} from "../libs/LpCollateralRouter.sol";

// see https://github.com/circlefin/stablecoin-evm/blob/master/doc/tokendesign.md#issuing-and-destroying-tokens
contract HypFiatToken is TokenRouter {
    using ERC20Collateral for IFiatToken;

    IFiatToken public immutable wrappedToken;

    /// @dev This is used to enable storage layout backwards compatibility. It should not be read or written to.
    LpCollateralRouterStorage private __LP_COLLATERAL_GAP;

    constructor(
        address _fiatToken,
        uint256 _scale,
        address _mailbox
    ) TokenRouter(_scale, _mailbox) {
        wrappedToken = IFiatToken(_fiatToken);
        _disableInitializers();
    }

    function initialize(
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) public initializer {
        _MailboxClient_initialize({
            _hook: _hook,
            __interchainSecurityModule: _interchainSecurityModule,
            _owner: _owner
        });
    }

    // ============ TokenRouter overrides ============
    function token() public view override returns (address) {
        return address(wrappedToken);
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to burn tokens on outbound transfer.
     */
    function _transferFromSender(uint256 _amount) internal override {
        // transfer amount to address(this)
        wrappedToken._transferFromSender(_amount);
        // burn amount of address(this) balance
        wrappedToken.burn(_amount);
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to mint tokens on inbound transfer.
     */
    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal override {
        require(
            wrappedToken.mint(_recipient, _amount),
            "FiatToken mint failed"
        );
    }
}
