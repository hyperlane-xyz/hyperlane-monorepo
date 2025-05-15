// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {ICcipReadIsm} from "../../interfaces/isms/ICcipReadIsm.sol";
import {MailboxClient} from "../../client/MailboxClient.sol";

/**
 * @title AbstractCcipReadIsm
 * @notice An ISM that allows arbitrary payloads to be submitted and verified on chain
 * @dev https://eips.ethereum.org/EIPS/eip-3668
 * @dev The AbstractCcipReadIsm provided by Hyperlane is left intentionally minimalist as
 * the range of applications that could be supported by a CcipReadIsm are so broad. However
 * there are few things to note when building a custom CcipReadIsm.
 *
 * 1. `getOffchainVerifyInfo` should revert with a `OffchainLookup` error, which encodes
 *    the data necessary to query for offchain information
 * 2. For full CCIP Read specification compatibility, CcipReadIsm's should expose a function
 *    that in turn calls `process` on the configured Mailbox with the provided metadata and
 *    message. This functions selector should be provided as the `callbackFunction` payload
 *    for the OffchainLookup error
 */
abstract contract AbstractCcipReadIsm is ICcipReadIsm, MailboxClient {
    // ============ Constants ============

    // solhint-disable-next-line const-name-snakecase
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.CCIP_READ);

    string[] internal _urls;

    constructor(
        address _mailbox,
        string[] memory __urls
    ) MailboxClient(_mailbox) {
        setUrls(__urls);
    }

    function setUrls(string[] memory __urls) public onlyOwner {
        _urls = __urls;
    }

    /// @dev called by the relayer when the off-chain data is ready
    function process(
        bytes calldata _metadata,
        bytes calldata _message
    ) external {
        mailbox.process(_metadata, _message);
    }

    function getOffchainVerifyInfo(
        bytes calldata _message
    ) external view override {
        revert OffchainLookup({
            sender: address(this),
            urls: _urls,
            callData: _offchainLookupCalldata(_message),
            callbackFunction: this.process.selector,
            extraData: _message
        });
    }

    function urls() external view returns (string[] memory) {
        return _urls;
    }

    function _offchainLookupCalldata(
        bytes calldata _message
    ) internal view virtual returns (bytes memory);
}
