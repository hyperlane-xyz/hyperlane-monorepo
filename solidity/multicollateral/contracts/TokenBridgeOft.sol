// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "@hyperlane-xyz/core/token/libs/TokenRouter.sol";
import {IOFT, SendParam, MessagingFee, MessagingReceipt, OFTReceipt} from "./interfaces/layerzero/IOFT.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EnumerableMap} from "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";

/**
 * @title TokenBridgeOft
 * @notice Warp route adapter for LayerZero OFT (Omnichain Fungible Token) contracts.
 *
 * @dev TokenRouter coupling:
 *  This contract extends TokenRouter to integrate with the Hyperlane warp route
 *  deployer and SDK. However, it does NOT use Hyperlane messaging for transfers.
 *  Instead, _transferRemote bridges via OFT.send() and _handle reverts on inbound
 *  Hyperlane messages. The Mailbox address passed to the constructor is required by
 *  TokenRouter's initializer but is not used for dispatching. The scale factors
 *  (1, 1) passed to TokenRouter(...) avoid decimal conversion since OFT handles
 *  its own decimal normalization via sharedDecimals.
 *
 * Supports all OFT patterns:
 *  - Native OFT (burn/mint, approvalRequired=false)
 *  - OFTAdapter (lock/unlock, approvalRequired=true)
 *  - OFTWrapper (Paxos-style burn/mint, approvalRequired=false)
 *
 * Token support:
 *  - Fee-on-transfer tokens: NOT supported — amount mismatches between
 *    safeTransferFrom and OFT.send will cause failures or loss.
 *  - Rebasing tokens: NOT supported — amounts may diverge across chains.
 *  - ERC-777: NOT explicitly supported — hook reentrancy not guarded.
 */
contract TokenBridgeOft is TokenRouter {
    using SafeERC20 for IERC20;
    using EnumerableMap for EnumerableMap.UintToUintMap;

    // ============ Errors ============

    error LzEidNotConfigured(uint32 hyperlaneDomain);

    // ============ Events ============

    event DomainAdded(uint32 indexed hyperlaneDomain, uint32 lzEid);
    event DomainRemoved(uint32 indexed hyperlaneDomain);
    event ExtraOptionsSet(bytes extraOptions);

    // ============ Storage ============

    /// @notice The LayerZero OFT contract to bridge through
    IOFT public immutable oft;

    /// @notice The underlying ERC20 token
    IERC20 public immutable wrappedToken;

    /// @notice Enumerable mapping from Hyperlane domain ID to LayerZero endpoint ID
    EnumerableMap.UintToUintMap private _domainToLzEid;

    /// @notice Configurable LayerZero extra options (e.g., destination gas limits)
    bytes public extraOptions;

    // ============ Constructor ============

    /**
     * @param _oft Address of the OFT / OFTAdapter / OFTWrapper contract
     * @param _mailbox Address of the Hyperlane Mailbox (for deployer compatibility)
     */
    constructor(address _oft, address _mailbox) TokenRouter(1, 1, _mailbox) {
        require(_oft != address(0), "TokenBridgeOft: zero OFT address");

        oft = IOFT(_oft);
        wrappedToken = IERC20(IOFT(_oft).token());

        // If the OFT is an adapter (lock/unlock), pre-approve it to spend tokens
        if (IOFT(_oft).approvalRequired()) {
            IERC20(IOFT(_oft).token()).safeApprove(_oft, type(uint256).max);
        }
    }

    function initialize(
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) public initializer {
        _MailboxClient_initialize(_hook, _interchainSecurityModule, _owner);
    }

    // ============ TokenRouter Overrides ============

    /// @notice Returns the address of the underlying ERC20 token.
    function token() public view override returns (address) {
        return address(wrappedToken);
    }

    /**
     * @dev Override to return LayerZero OFT native fee instead of Hyperlane IGP fee.
     * This is called by TokenRouter.quoteTransferRemote().
     */
    function _quoteGasPayment(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        address /* _feeToken */
    ) internal view override returns (uint256) {
        SendParam memory sendParam = _buildSendParam(
            _destination,
            _recipient,
            _amount,
            0 // minAmountLD = 0 for quoting
        );
        MessagingFee memory msgFee = oft.quoteSend(sendParam, false);
        return msgFee.nativeFee;
    }

    /**
     * @dev Override to bridge via OFT.send() instead of Hyperlane dispatch.
     * Flow: pull tokens → OFT.send() with msg.sender as LZ refund → refund
     * any excess msg.value back to caller.
     */
    function _transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal override returns (bytes32 messageId) {
        uint256 balBefore = address(this).balance - msg.value;

        // Pull tokens from sender
        _transferFromSender(_amount);

        // Build OFT send params
        SendParam memory sendParam = _buildSendParam(
            _destination,
            _recipient,
            _amount,
            0 // placeholder, will be set from quoteOFT
        );

        // Get the expected receipt to set minAmountLD for slippage protection
        (, , OFTReceipt memory receipt) = oft.quoteOFT(sendParam);
        sendParam.minAmountLD = receipt.amountReceivedLD;

        // Get native gas fee
        MessagingFee memory msgFee = oft.quoteSend(sendParam, false);

        // Execute the OFT send — LZ refunds go to msg.sender
        (MessagingReceipt memory msgReceipt, ) = oft.send{
            value: msgFee.nativeFee
        }(sendParam, msgFee, msg.sender);

        // Refund excess msg.value (re-quote difference) back to caller
        uint256 excess = address(this).balance - balBefore;
        if (excess > 0) {
            // solhint-disable-next-line avoid-low-level-calls
            (bool ok, ) = msg.sender.call{value: excess}("");
            require(ok, "TokenBridgeOft: ETH refund failed");
        }

        emit SentTransferRemote(_destination, _recipient, _amount);
        return msgReceipt.guid;
    }

    /// @dev Pull tokens from msg.sender to this contract.
    function _transferFromSender(uint256 _amount) internal override {
        wrappedToken.safeTransferFrom(msg.sender, address(this), _amount);
    }

    /// @dev No-op — OFT delivers tokens directly to recipients on the destination chain.
    function _transferTo(address, uint256) internal pure override {
        // Intentionally empty: OFT handles token delivery
    }

    /**
     * @dev Revert on inbound Hyperlane messages — tokens arrive via LayerZero, not Hyperlane.
     */
    function _handle(uint32, bytes32, bytes calldata) internal pure override {
        revert("TokenBridgeOft: no inbound handling");
    }

    // ============ Admin ============

    function addDomain(
        uint32 _hyperlaneDomain,
        uint32 _lzEid
    ) external onlyOwner {
        require(_lzEid != 0, "TokenBridgeOft: zero LZ EID");
        _domainToLzEid.set(uint256(_hyperlaneDomain), uint256(_lzEid));
        emit DomainAdded(_hyperlaneDomain, _lzEid);
    }

    function removeDomain(uint32 _hyperlaneDomain) external onlyOwner {
        bool removed = _domainToLzEid.remove(uint256(_hyperlaneDomain));
        require(removed, "TokenBridgeOft: domain not configured");
        emit DomainRemoved(_hyperlaneDomain);
    }

    function setExtraOptions(bytes calldata _options) external onlyOwner {
        extraOptions = _options;
        emit ExtraOptionsSet(_options);
    }

    // ============ Views ============

    /// @notice Look up the LZ endpoint ID for a given Hyperlane domain.
    function hyperlaneDomainToLzEid(
        uint32 _domain
    ) external view returns (uint32) {
        (bool exists, uint256 eid) = _domainToLzEid.tryGet(uint256(_domain));
        return exists ? uint32(eid) : 0;
    }

    /// @notice Returns all configured domain mappings as parallel arrays.
    function getDomainMappings()
        external
        view
        returns (uint32[] memory domains, uint32[] memory lzEids)
    {
        uint256 len = _domainToLzEid.length();
        domains = new uint32[](len);
        lzEids = new uint32[](len);
        for (uint256 i = 0; i < len; i++) {
            (uint256 domain, uint256 eid) = _domainToLzEid.at(i);
            domains[i] = uint32(domain);
            lzEids[i] = uint32(eid);
        }
    }

    // ============ Internal ============

    function _buildSendParam(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        uint256 _minAmountLD
    ) internal view returns (SendParam memory) {
        (bool exists, uint256 eid) = _domainToLzEid.tryGet(
            uint256(_destination)
        );
        if (!exists) revert LzEidNotConfigured(_destination);
        uint32 lzEid = uint32(eid);

        return
            SendParam({
                dstEid: lzEid,
                to: _recipient,
                amountLD: _amount,
                minAmountLD: _minAmountLD,
                extraOptions: extraOptions,
                composeMsg: "",
                oftCmd: ""
            });
    }

    /// @notice Allow contract to receive native token refunds from OFT
    receive() external payable {}
}
