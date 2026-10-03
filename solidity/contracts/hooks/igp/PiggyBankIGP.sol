// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {AbstractPostDispatchHook} from "../libs/AbstractPostDispatchHook.sol";
import {Message} from "../../libs/Message.sol";

/**
 * @title PiggyBankIGP
 * @notice A hook that sponsors gas payments on behalf of configured sender addresses.
 */
contract PiggyBankIGP is AbstractPostDispatchHook {
    using Message for bytes;

    // The underlying IGP to route payments to
    IPostDispatchHook public immutable innerIGP;

    // Balances of native token for each sponsor
    mapping(address => uint256) public sponsorBalances;

    // Mapping from sender contract address (bytes32) to sponsor address
    mapping(bytes32 => address) public senderToSponsor;

    event SponsorDeposited(address indexed sponsor, uint256 amount);
    event SponsorWithdrew(address indexed sponsor, uint256 amount);
    event SenderSponsorSet(bytes32 indexed sender, address indexed sponsor);
    event GasSponsored(address indexed sponsor, bytes32 indexed sender, uint256 fee);

    /**
     * @notice Initializes the PiggyBankIGP with an inner IGP.
     * @param _innerIGP The underlying IGP to route gas payments to.
     */

    constructor(IPostDispatchHook _innerIGP) {
        innerIGP = _innerIGP;
    }

    /**
     * @notice Accepts direct native token transfers.
     */

    receive() external payable {}

    /**
     * @notice Deposit native tokens to sponsor gas payments.
     */
    function deposit() external payable {
        sponsorBalances[msg.sender] += msg.value;
        emit SponsorDeposited(msg.sender, msg.value);
    }

    /**
     * @notice Withdraw deposited native tokens.
     * @param amount The amount to withdraw.
     */
    function withdraw(uint256 amount) external {
        require(sponsorBalances[msg.sender] >= amount, "PiggyBankIGP: insufficient balance");
        sponsorBalances[msg.sender] -= amount;
        emit SponsorWithdrew(msg.sender, amount);
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "PiggyBankIGP: withdraw failed");
    }

    /**
     * @notice Set the sponsor for a specific sender address.
     * @param sender The address of the sender contract.
     */
    function setSponsor(bytes32 sender) external {
        require(senderToSponsor[sender] == address(0) || senderToSponsor[sender] == msg.sender, "PiggyBankIGP: sponsor already set");
        senderToSponsor[sender] = msg.sender;
        emit SenderSponsorSet(sender, msg.sender);
    }

    /**
     * @notice Unset the sponsor for a specific sender address.
     * @param sender The address of the sender contract.
     */
    function unsetSponsor(bytes32 sender) external {
        require(senderToSponsor[sender] == msg.sender, "PiggyBankIGP: not the sponsor");
        senderToSponsor[sender] = address(0);
        emit SenderSponsorSet(sender, address(0));
    }

    /**
     * @notice Returns the hook type.
     * @return The hook type enum value.
     */

    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.HookTypes.INTERCHAIN_GAS_PAYMASTER);
    }

    /**
     * @notice Performs the post-dispatch logic, deducting fee from sponsor.
     * @param metadata Hook metadata.
     * @param message The dispatched message.
     */

    function _postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal override {
        bytes32 sender = message.senderAddress();
        address sponsor = senderToSponsor[sender];
        require(sponsor != address(0), "PiggyBankIGP: unconfigured sender");

        uint256 fee = innerIGP.quoteDispatch(metadata, message);
        require(sponsorBalances[sponsor] >= fee, "PiggyBankIGP: insufficient balance");

        sponsorBalances[sponsor] -= fee;
        emit GasSponsored(sponsor, sender, fee);

        innerIGP.postDispatch{value: fee}(metadata, message);
    }

    /**
     * @notice Returns zero since the sender does not pay the fee.
     * @param metadata Hook metadata.
     * @param message The dispatched message.
     * @return Always returns 0.
     */

    function _quoteDispatch(
        bytes calldata /*metadata*/,
        bytes calldata /*message*/
    ) internal pure override returns (uint256) {
        // Return 0 because the user calling dispatch doesn't need to send msg.value!
        // The fee is paid from the sponsor's balance inside _postDispatch.
        return 0;
    }
}
