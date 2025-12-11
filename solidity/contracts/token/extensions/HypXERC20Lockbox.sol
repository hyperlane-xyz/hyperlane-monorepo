// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IXERC20Lockbox} from "../interfaces/IXERC20Lockbox.sol";
import {IXERC20, IERC20} from "../interfaces/IXERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {TokenRouter} from "../libs/TokenRouter.sol";
import {ERC20Collateral} from "../libs/TokenCollateral.sol";
import {LpCollateralRouterStorage} from "../libs/LpCollateralRouter.sol";

contract HypXERC20Lockbox is TokenRouter {
    using SafeERC20 for IERC20;
    using ERC20Collateral for IERC20;

    uint256 constant MAX_INT = 2 ** 256 - 1;

    IXERC20Lockbox public immutable lockbox;
    IXERC20 public immutable xERC20;
    IERC20 public immutable wrappedToken;

    /// @dev This is used to enable storage layout backwards compatibility. It should not be read or written to.
    LpCollateralRouterStorage private __LP_COLLATERAL_GAP;

    constructor(
        address _lockbox,
        uint256 _scale,
        address _mailbox
    ) TokenRouter(_scale, _mailbox) {
        lockbox = IXERC20Lockbox(_lockbox);
        xERC20 = IXERC20(lockbox.XERC20());
        wrappedToken = IERC20(lockbox.ERC20());
        approveLockbox();
        _disableInitializers();
    }

    /**
     * @notice Approve the lockbox to spend the wrapped token and xERC20
     * @dev This function is idempotent and need not be access controlled
     */
    function approveLockbox() public {
        wrappedToken.safeApprove(address(lockbox), MAX_INT);
        IERC20(xERC20).safeApprove(address(lockbox), MAX_INT);
    }

    /**
     * @notice Initialize the contract
     * @param _hook The address of the hook contract
     * @param _ism The address of the interchain security module
     * @param _owner The address of the owner
     */
    function initialize(
        address _hook,
        address _ism,
        address _owner
    ) public initializer {
        approveLockbox();
        _MailboxClient_initialize({
            _hook: _hook,
            __interchainSecurityModule: _ism,
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
        // transfer erc20 from sender
        wrappedToken._transferFromSender(_amount);
        // convert erc20 to xERC20
        lockbox.deposit(_amount);
        // burn xERC20
        xERC20.burn(address(this), _amount);
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to mint tokens on inbound transfer.
     */
    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal override {
        // mint xERC20
        xERC20.mint(address(this), _amount);
        // convert xERC20 to erc20
        lockbox.withdrawTo(_recipient, _amount);
    }
}
