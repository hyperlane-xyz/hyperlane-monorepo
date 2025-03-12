// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IXERC20Lockbox} from "../interfaces/IXERC20Lockbox.sol";
import {IXERC20, IERC20} from "../interfaces/IXERC20.sol";
import {HypERC20Collateral} from "../HypERC20Collateral.sol";

contract HypXERC20Lockbox is HypERC20Collateral {
    uint256 constant MAX_INT = 2 ** 256 - 1;

    IXERC20Lockbox public immutable lockbox;
    IXERC20 public immutable xERC20;

    constructor(
        address _lockbox,
        uint256 _scale,
        address _mailbox
    )
        HypERC20Collateral(
            address(IXERC20Lockbox(_lockbox).ERC20()),
            _scale,
            _mailbox
        )
    {
        lockbox = IXERC20Lockbox(_lockbox);
        xERC20 = lockbox.XERC20();
        approveLockbox();
        _disableInitializers();
    }

    /**
     * @notice Approve the lockbox to spend the wrapped token and xERC20
     * @dev This function is idempotent and need not be access controlled
     */
    function approveLockbox() public {
        require(
            IERC20(wrappedToken).approve(address(lockbox), MAX_INT),
            "erc20 lockbox approve failed"
        );
        require(
            xERC20.approve(address(lockbox), MAX_INT),
            "xerc20 lockbox approve failed"
        );
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
    ) public override initializer {
        approveLockbox();
        _MailboxClient_initialize(_hook, _ism, _owner);
    }

    function _transferFromSender(
        uint256 _amount
    ) internal override returns (bytes memory) {
        // transfer erc20 from sender
        super._transferFromSender(_amount);
        // convert erc20 to xERC20
        lockbox.deposit(_amount);
        // burn xERC20
        xERC20.burn(address(this), _amount);
        return bytes("");
    }

    function _transferTo(
        address _recipient,
        uint256 _amount,
        bytes calldata /*metadata*/
    ) internal override {
        // mint xERC20
        xERC20.mint(address(this), _amount);
        // convert xERC20 to erc20
        lockbox.withdrawTo(_recipient, _amount);
    }
}
