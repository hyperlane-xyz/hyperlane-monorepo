// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
// ============ Internal Imports ============
import {TypeCasts} from "./TypeCasts.sol";
// ============ External Imports ============
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

library ValidatorAnnouncements {
    using TypeCasts for address;

    /**
     * @notice Returns the digest validators are expected to sign when signing announcements.
     * @param _mailbox Address of the mailbox being validated
     * @param _localDomain Domain of chain on which the contract is deployed
     * @param _storageLocation Storage location string.
     * @return The digest of the announcement.
     */
    function getAnnouncementDigest(
        address _mailbox,
        uint32 _localDomain,
        string memory _storageLocation
    ) internal pure returns (bytes32) {
        bytes32 _domainHash = keccak256(
            abi.encodePacked(
                _localDomain,
                _mailbox.addressToBytes32(),
                "HYPERLANE_ANNOUNCEMENT"
            )
        );
        return
            ECDSA.toEthSignedMessageHash(
                keccak256(abi.encodePacked(_domainHash, _storageLocation))
            );
    }
}
