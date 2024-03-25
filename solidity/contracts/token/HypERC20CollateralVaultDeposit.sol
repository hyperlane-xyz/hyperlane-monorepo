// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;
import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {HypERC20Collateral} from "./HypERC20Collateral.sol";

/**
 * @title Hyperlane ERC20 Token Collateral with deposits collateral to a vault
 * @author ltyu
 */
contract HypERC20CollateralVaultDeposit is HypERC20Collateral {
    // Address of the ERC4626 compatible vault
    ERC4626 public immutable vault;

    // Internal balance of total asset deposited
    uint256 public assetDeposited;

    event ExcessSharesSwept(uint256 amount, uint256 assetsRedeemed);

    constructor(
        ERC4626 _vault,
        address _mailbox
    ) HypERC20Collateral(_vault.asset(), _mailbox) {
        vault = _vault;
    }

    function initialize(
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) public override initializer {
        wrappedToken.approve(address(vault), type(uint256).max);
        _MailboxClient_initialize(_hook, _interchainSecurityModule, _owner);
    }

    /**
     * @dev Transfers `_amount` of `wrappedToken` from `msg.sender` to this contract, and deposit into vault
     * @inheritdoc HypERC20Collateral
     */
    function _transferFromSender(
        uint256 _amount
    ) internal override returns (bytes memory metadata) {
        metadata = super._transferFromSender(_amount);
        _depositIntoVault(_amount);
    }

    /**
     * @dev Deposits into the vault and increment assetDeposited
     * @param _amount amount to deposit into vault
     */
    function _depositIntoVault(uint256 _amount) internal {
        assetDeposited += _amount;
        vault.deposit(_amount, address(this));
    }

    /**
     * @dev Transfers `_amount` of `wrappedToken` from this contract to `_recipient`, and withdraws from vault
     * @inheritdoc HypERC20Collateral
     */
    function _transferTo(
        address _recipient,
        uint256 _amount,
        bytes calldata
    ) internal virtual override {
        _withdrawFromVault(_amount, _recipient);
    }

    /**
     * @dev Withdraws from the vault and decrement assetDeposited
     * @param _amount amount to withdraw from vault
     * @param _recipient address to deposit withdrawn underlying to
     */
    function _withdrawFromVault(uint256 _amount, address _recipient) internal {
        assetDeposited -= _amount;
        vault.withdraw(_amount, _recipient, address(this));
    }

    /**
     * @notice Allows the owner to redeem excess shares
     */
    function sweep() external onlyOwner {
        uint256 excessShares = vault.maxRedeem(address(this)) -
            vault.convertToShares(assetDeposited);
        uint256 assetsRedeemed = vault.redeem(
            excessShares,
            owner(),
            address(this)
        );
        emit ExcessSharesSwept(excessShares, assetsRedeemed);
    }
}
