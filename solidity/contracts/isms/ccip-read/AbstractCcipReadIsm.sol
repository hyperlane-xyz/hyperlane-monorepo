// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {ICcipReadIsm} from "../../interfaces/isms/ICcipReadIsm.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";

// ============ External Imports ============
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/**
 * @title AbstractCcipReadIsm
 * @notice An ISM that allows arbitrary payloads to be submitted and verified on chain
 * @dev https://eips.ethereum.org/EIPS/eip-3668
 * @dev The AbstractCcipReadIsm provided by Hyperlane is left intentionally minimalist as
 * the range of applications that could be supported by a CcipReadIsm are so broad. However
 * there are few things to note when building a custom CcipReadIsm.
 *
 */
abstract contract AbstractCcipReadIsm is
    ICcipReadIsm,
    OwnableUpgradeable,
    PackageVersioned
{
    // ============ Constants ============

    // solhint-disable-next-line const-name-snakecase
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.CCIP_READ);

    string[] internal _urls;

    /**
     * @notice Emitted when new CCIP-read urls are being set
     */
    event UrlsChanged(string[] newUrls);

    function setUrls(string[] memory __urls) public onlyOwner {
        require(__urls.length > 0, "AbstractCcipReadIsm: urls cannot be empty");
        _urls = __urls;
        emit UrlsChanged(__urls);
    }

    function getOffchainVerifyInfo(
        bytes calldata _message
    ) external view override {
        revert OffchainLookup({
            sender: address(this),
            urls: _urls,
            callData: _offchainLookupCalldata(_message),
            callbackFunction: this.verify.selector,
            extraData: _message
        });
    }

    function urls() external view returns (string[] memory) {
        return _urls;
    }

    /*
     * @dev This should return the calldata to be used for the offchain lookup.
     **/
    function _offchainLookupCalldata(
        bytes calldata _message
    ) internal view virtual returns (bytes memory);
}
