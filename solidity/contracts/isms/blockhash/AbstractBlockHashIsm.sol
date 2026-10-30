// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IAggregationIsm} from "../../interfaces/isms/IAggregationIsm.sol";
import {AggregationIsmMetadata} from "../../isms/libs/AggregationIsmMetadata.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";
import {IBlockHashOracle} from "./IBlockHashOracle.sol";
import {Message} from "../../libs/Message.sol";

/**
 * @title AggregationIsm
 * @notice Manages per-domain m-of-n ISM sets that are used to verify
 * interchain messages.
 */
abstract contract AbstractBlockHashIsm is IAggregationIsm, PackageVersioned {
    using Message for bytes;
    // ============ Constants ============
    // Use Blockhash oracle address
    IBlockHashOracle public blockHashOracle = IBlockHashOracle(address(0));

    // solhint-disable-next-line const-name-snakecase
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.AGGREGATION);

    // ============ Virtual Functions ============
    // ======= OVERRIDE THESE TO IMPLEMENT =======

    /**
     * @notice Returns the set of ISMs responsible for verifying _message
     * and the number of ISMs that must verify
     * @dev Can change based on the content of _message
     * @param _message Hyperlane formatted interchain message
     * @return modules The array of ISM addresses
     * @return threshold The number of ISMs needed to verify
     */
    function modulesAndThreshold(
        bytes calldata _message
    ) public view virtual returns (address[] memory, uint8);

    // ============ Public Functions ============]

    /**
     * @notice Requires that m-of-n ISMs verify the provided interchain message.
     * @param _metadata ABI encoded module metadata (see AggregationIsmMetadata.sol)
     * @param _message Formatted Hyperlane message (see Message.sol).
     */
    function verify(
        bytes calldata _metadata,
        bytes calldata _message
    ) public returns (bool) {
        // Step 1: Verify the message using the aggregation ISM logic
        (address[] memory _isms, uint8 _threshold) = modulesAndThreshold(
            _message
        );
        uint256 _count = _isms.length;
        for (uint8 i = 0; i < _count; i++) {
            if (!AggregationIsmMetadata.hasMetadata(_metadata, i)) continue;
            IInterchainSecurityModule _ism = IInterchainSecurityModule(
                _isms[i]
            );
            require(
                _ism.verify(
                    AggregationIsmMetadata.metadataAt(_metadata, i),
                    _message
                ),
                "!verify"
            );
            _threshold -= 1;
        }

        // Step 2: Decode the message to extract fields
        uint32 originDomain = _message.origin();
        uint32 expectedOriginDomain = blockHashOracle.origin();

        // Step 3: Extract block information from the message
        (uint256 blockHash, uint256 blockHeight) = _extractBlockInfo(
            _message.body()
        );

        uint256 expectedBlockHash = blockHashOracle.blockHash(blockHeight);
        // Step 4: Verify the origin domain matches the expected origin domain and the threshold is zero
        require(
            _threshold == 0 &&
                expectedOriginDomain == originDomain &&
                expectedBlockHash == blockHash,
            "validation_error"
        );

        // Step 4: Return true if all checks pass
        return true;
    }

    function _extractBlockInfo(
        bytes calldata _messageBody
    ) internal view returns (uint256 hash, uint256 height) {
        require(_messageBody.length >= 64, "Invalid message body");

        (hash, height) = abi.decode(_messageBody[:64], (uint256, uint256));
    }
}
