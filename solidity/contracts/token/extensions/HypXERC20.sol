// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IXERC20} from "../interfaces/IXERC20.sol";
import {HypERC20Collateral} from "../HypERC20Collateral.sol";
import {TokenRouter} from "../libs/TokenRouter.sol";
import {LpCollateralRouterStorage} from "../libs/LpCollateralRouter.sol";

contract HypXERC20 is TokenRouter {
    IXERC20 public immutable wrappedToken;

    /// @dev This is used to enable storage layout backwards compatibility. It should not be read or written to.
    LpCollateralRouterStorage private __LP_COLLATERAL_GAP;

    constructor(
        address _xerc20,
        uint256 _scale,
        address _mailbox
    ) TokenRouter(_scale, _mailbox) {
        wrappedToken = IXERC20(_xerc20);
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
    function _transferFromSender(uint256 _amountOrId) internal override {
        wrappedToken.burn(msg.sender, _amountOrId);
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to mint tokens on inbound transfer.
     */
    function _transferTo(
        address _recipient,
        uint256 _amountOrId
    ) internal override {
        wrappedToken.mint(_recipient, _amountOrId);
    }
}
