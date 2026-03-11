// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "@hyperlane-xyz/core/token/libs/TokenRouter.sol";
import {IOFT, SendParam, MessagingFee, MessagingReceipt, OFTReceipt} from "./interfaces/layerzero/IOFT.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EnumerableMap} from "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

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
 * @dev Dust and decimal handling:
 *  OFTs use "sharedDecimals" (typically 6) as a wire format, regardless of the
 *  token's local decimals. When localDecimals > sharedDecimals, the OFT truncates
 *  sub-sharedDecimals precision ("dust") via _removeDust() before sending. This
 *  contract stores the decimalConversionRate (10^(localDecimals - sharedDecimals))
 *  as an immutable and uses it to:
 *    1. Round grossAmount UP to the next dust-free boundary after fee inversion,
 *       preventing SlippageExceeded reverts from the OFT.
 *    2. Round minAmountLD DOWN to a dust-free value, since the OFT cannot deliver
 *       sub-dust precision anyway.
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

    /// @notice 10^(localDecimals - sharedDecimals). Amounts are only meaningful
    /// at multiples of this value; sub-dust precision is truncated by the OFT.
    /// Equals 1 when localDecimals == sharedDecimals (no dust).
    uint256 public immutable decimalConversionRate;

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
        address _token = IOFT(_oft).token();
        wrappedToken = IERC20(_token);

        uint8 localDecimals = IERC20Metadata(_token).decimals();
        uint8 sharedDecimals = IOFT(_oft).sharedDecimals();
        require(
            localDecimals >= sharedDecimals,
            "TokenBridgeOft: localDecimals < sharedDecimals"
        );
        decimalConversionRate = 10 ** (localDecimals - sharedDecimals);
    }

    function initialize(
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) public initializer {
        _MailboxClient_initialize(_hook, _interchainSecurityModule, _owner);

        // Approve in initialize (not constructor) so the approval is set on the
        // proxy's address, not the implementation's.
        wrappedToken.safeApprove(address(oft), type(uint256).max);
    }

    // ============ TokenRouter Overrides ============

    /// @notice Returns the address of the underlying ERC20 token.
    function token() public view override returns (address) {
        return address(wrappedToken);
    }

    /// @dev ERC20 fee hooks are incompatible: _quoteGasPayment returns LZ native
    /// fees in wei, which _calculateFeesAndCharge would misinterpret as ERC20
    /// amounts if a feeHook were set. Always return address(0) to disable.
    function feeHook() public pure override returns (address) {
        return address(0);
    }

    /**
     * @dev Override to return LayerZero OFT native fee instead of Hyperlane IGP fee.
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
            0
        );
        MessagingFee memory msgFee = oft.quoteSend(sendParam, false);
        return msgFee.nativeFee;
    }

    /**
     * @dev Override to surface OFT token fees as an external fee in quoteTransferRemote.
     * This is the difference between what we must send the OFT and what the recipient gets.
     */
    function _externalFeeAmount(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal view override returns (uint256) {
        return _grossOftAmount(_destination, _recipient, _amount) - _amount;
    }

    /**
     * @dev Override to bridge via OFT.send() instead of Hyperlane dispatch.
     * Reuses the base fee charging logic (_calculateFeesAndCharge) which pulls
     * grossAmount (= _amount + externalFee) from sender and distributes any
     * protocol fees. Then sends the gross amount through the OFT with
     * dust-free _amount as the minimum received.
     */
    function _transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal override returns (bytes32 messageId) {
        // 1. Charge fees — pulls _amount + externalFee (OFT fee) from sender
        (
            uint256 externalFee,
            uint256 remainingNativeValue
        ) = _calculateFeesAndCharge(
                _destination,
                _recipient,
                _amount,
                msg.value,
                feeHook()
            );

        // 2. Build OFT send params: send grossAmount, enforce dust-free _amount as minimum received.
        // minAmountLD uses _removeDust because the OFT cannot deliver sub-dust precision.
        uint256 grossAmount = _amount + externalFee;
        SendParam memory sendParam = _buildSendParam(
            _destination,
            _recipient,
            grossAmount,
            _removeDust(_amount)
        );

        // 3. Quote native gas fee and send via OFT
        MessagingFee memory msgFee = MessagingFee({
            nativeFee: _quoteGasPayment(
                _destination,
                _recipient,
                _amount,
                address(0)
            ),
            lzTokenFee: 0
        });

        emit SentTransferRemote(_destination, _recipient, _amount);

        (MessagingReceipt memory msgReceipt, ) = oft.send{
            value: msgFee.nativeFee
        }(sendParam, msgFee, msg.sender);

        // 4. Refund excess native value back to caller
        uint256 excessNative = remainingNativeValue - msgFee.nativeFee;
        if (excessNative > 0) {
            // solhint-disable-next-line avoid-low-level-calls
            (bool ok, ) = msg.sender.call{value: excessNative}("");
            require(ok, "TokenBridgeOft: ETH refund failed");
        }

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

    /// @dev Override to transfer fees via ERC20 instead of _transferTo (which is a no-op).
    function _transferFee(
        address _recipient,
        uint256 _amount
    ) internal override {
        wrappedToken.safeTransfer(_recipient, _amount);
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
        return _getLzEid(_domain);
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

    function _getLzEid(uint32 _domain) internal view returns (uint32) {
        (bool exists, uint256 eid) = _domainToLzEid.tryGet(uint256(_domain));
        if (!exists) revert LzEidNotConfigured(_domain);
        return uint32(eid);
    }

    function _buildSendParam(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        uint256 _minAmountLD
    ) internal view returns (SendParam memory) {
        return
            SendParam({
                dstEid: _getLzEid(_destination),
                to: _recipient,
                amountLD: _amount,
                minAmountLD: _minAmountLD,
                extraOptions: extraOptions,
                composeMsg: "",
                oftCmd: ""
            });
    }

    /**
     * @dev Analytically invert the OFT fee to compute the gross input amount
     * such that the recipient receives at least _amount after OFT deductions.
     *
     * OFT fees are linear (percentage-based), so the inversion is:
     *   grossAmount = ceil(_amount * amountSentLD / amountReceivedLD)
     *
     * After inversion, grossAmount is rounded UP to the next dust-free boundary.
     * This is necessary because OFTs internally call _removeDust() which truncates
     * sub-sharedDecimals precision. Without this rounding, the truncated gross
     * amount after fee deduction can fall below _amount, causing SlippageExceeded.
     *
     * Example with 18 local / 6 shared decimals and 1% fee:
     *   _amount = 1e18, probe gives sent=1e18, received=0.99e18
     *   ceilDiv → 1010101010101010102 (has dust in last 12 digits)
     *   OFT would truncate to 1010101000000000000, then deduct 1% → 0.99999999e18 < 1e18
     *   Rounding up to 1010102000000000000 ensures post-fee amount >= 1e18
     *
     * If the OFT charges no fee (amountSentLD == amountReceivedLD), returns _amount
     * rounded up to the nearest dust-free value (to handle dusty input amounts).
     * Reverts if the OFT returns amountReceivedLD == 0 (would indicate 100% fee).
     */
    function _grossOftAmount(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal view returns (uint256) {
        SendParam memory probeParam = _buildSendParam(
            _destination,
            _recipient,
            _amount,
            0
        );
        (, , OFTReceipt memory receipt) = oft.quoteOFT(probeParam);

        uint256 sent = receipt.amountSentLD;
        uint256 received = receipt.amountReceivedLD;

        // No fee: return _amount rounded up to dust-free boundary
        if (sent == received) return _roundUpDust(_amount);

        require(received > 0, "TokenBridgeOft: OFT 100% fee");

        // Analytical inversion, then round up to dust-free boundary
        uint256 gross = Math.ceilDiv(_amount * sent, received);
        return _roundUpDust(gross);
    }

    /// @dev Round `_amount` DOWN to the nearest dust-free value (mirrors OFT._removeDust).
    function _removeDust(uint256 _amount) internal view returns (uint256) {
        return (_amount / decimalConversionRate) * decimalConversionRate;
    }

    /// @dev Round `_amount` UP to the nearest dust-free value.
    function _roundUpDust(uint256 _amount) internal view returns (uint256) {
        uint256 rate = decimalConversionRate;
        return ((_amount + rate - 1) / rate) * rate;
    }

    /// @notice Allow contract to receive native token refunds from OFT
    receive() external payable {}
}
