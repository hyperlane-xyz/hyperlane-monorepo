// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

// ============ Internal Imports ============
import {EnumerableThresholdedSet} from "./EnumerableThresholdedSet.sol";
import {Message} from "./Message.sol";

abstract contract OwnableThresholdedSet is Ownable {
    // ============ Libraries ============

    using EnumerableThresholdedSet for EnumerableThresholdedSet.AddressSet;
    using Message for bytes;

    // ============ Mutable Storage ============

    /// @notice The thresholded set for each remote domain.
    mapping(uint32 => EnumerableThresholdedSet.AddressSet) private _sets;

    // ============ Events ============

    /**
     * @notice Emitted when a element is enrolled in a element set.
     * @param domain The remote domain of the element set.
     * @param element The address of the element.
     * @param elementCount The number of enrolled elements in the element set.
     */
    event ElementEnrolled(
        uint32 indexed domain,
        address indexed element,
        uint256 elementCount
    );

    /**
     * @notice Emitted when a element is unenrolled from a element set.
     * @param domain The remote domain of the element set.
     * @param element The address of the element.
     * @param elementCount The number of enrolled elements in the element set.
     */
    event ElementUnenrolled(
        uint32 indexed domain,
        address indexed element,
        uint256 elementCount
    );

    /**
     * @notice Emitted when the quorum threshold is set.
     * @param domain The remote domain of the element set.
     * @param threshold The new quorum threshold.
     */
    event ThresholdSet(uint32 indexed domain, uint8 threshold);

    /**
     * @notice Emitted when the element set or threshold changes.
     * @param domain The remote domain of the element set.
     * @param commitment A commitment to the element set and threshold.
     */
    event CommitmentUpdated(uint32 domain, bytes32 commitment);

    // ============ Constructor ============

    // solhint-disable-next-line no-empty-blocks
    constructor() Ownable() {}

    // ============ External Functions ============

    /**
     * @notice Enrolls multiple elements into a element set.
     * @dev Reverts if `_element` is already in the element set.
     * @param _domains The remote domains of the element sets.
     * @param _elements The elements to add to the element sets.
     * @dev _elements[i] are the elements to enroll for _domains[i].
     */
    function enrollElements(
        uint32[] calldata _domains,
        address[][] calldata _elements
    ) external onlyOwner {
        require(_domains.length == _elements.length, "!length");
        for (uint256 i = 0; i < _domains.length; i += 1) {
            uint32 _domain = _domains[i];
            EnumerableThresholdedSet.AddressSet storage _set = _sets[_domain];
            for (uint256 j = 0; j < _elements[i].length; j += 1) {
                address _element = _elements[i][j];
                _set.add(_elements[i][j]);
                emit ElementEnrolled(_domain, _element, _set.length());
            }
            emit CommitmentUpdated(_domain, _set.commitment);
        }
    }

    /**
     * @notice Enrolls a element into a element set.
     * @dev Reverts if `_element` is already in the element set.
     * @param _domain The remote domain of the element set.
     * @param _element The element to add to the element set.
     */
    function enrollElement(uint32 _domain, address _element)
        external
        onlyOwner
    {
        EnumerableThresholdedSet.AddressSet storage _set = _sets[_domain];
        bytes32 _commitment = _set.add(_element);
        emit ElementEnrolled(_domain, _element, _set.length());
        emit CommitmentUpdated(_domain, _commitment);
    }

    /**
     * @notice Unenrolls a element from a element set.
     * @dev Reverts if `_element` is not in the element set.
     * @param _domain The remote domain of the element set.
     * @param _element The element to remove from the element set.
     */
    function unenrollElement(uint32 _domain, address _element)
        external
        onlyOwner
    {
        EnumerableThresholdedSet.AddressSet storage _set = _sets[_domain];
        bytes32 _commitment = _set.remove(_element);
        emit ElementUnenrolled(_domain, _element, _set.length());
        emit CommitmentUpdated(_domain, _commitment);
    }

    /**
     * @notice Sets the quorum threshold for multiple domains.
     * @param _domains The remote domains of the element sets.
     * @param _thresholds The new quorum thresholds.
     */
    function setThresholds(
        uint32[] calldata _domains,
        uint8[] calldata _thresholds
    ) external onlyOwner {
        require(_domains.length == _thresholds.length, "!length");
        for (uint256 i = 0; i < _domains.length; i += 1) {
            setThreshold(_domains[i], _thresholds[i]);
        }
    }

    /**
     * @notice Returns whether an address is enrolled in a element set.
     * @param _domain The remote domain of the element set.
     * @param _element The address to test for set membership.
     * @return True if the address is enrolled, false otherwise.
     */
    function isEnrolled(uint32 _domain, address _element)
        external
        view
        returns (bool)
    {
        return _sets[_domain].contains(_element);
    }

    // ============ Public Functions ============

    /**
     * @notice Sets the quorum threshold.
     * @param _domain The remote domain of the element set.
     * @param _threshold The new quorum threshold.
     */
    function setThreshold(uint32 _domain, uint8 _threshold) public onlyOwner {
        EnumerableThresholdedSet.AddressSet storage _set = _sets[_domain];
        bytes32 _commitment = _set.setThreshold(_threshold);
        emit ThresholdSet(_domain, _threshold);
        emit CommitmentUpdated(_domain, _commitment);
    }

    /**
     * @notice Gets the current element set
     * @param _domain The remote domain of the element set.
     * @return The addresses of the element set.
     */
    function elements(uint32 _domain) public view returns (address[] memory) {
        return _sets[_domain].values();
    }

    function threshold(uint32 _domain) public view returns (uint8) {
        return _sets[_domain].threshold;
    }

    /**
     * @notice Returns the number of elements enrolled in the element set.
     * @param _domain The remote domain of the element set.
     * @return The number of elements enrolled in the element set.
     */
    function elementCount(uint32 _domain) public view returns (uint256) {
        return _sets[_domain].length();
    }

    function setMatches(
        uint32 _domain,
        uint8 _threshold,
        bytes calldata _elements
    ) public view returns (bool) {
        return _sets[_domain].matches(_threshold, _elements);
    }

    /**
     * @notice Returns the set of elements responsible for verifying _message
     * and the number of signatures required
     * @dev Can change based on the content of _message
     * @param _message Hyperlane formatted interchain message
     * @return elements The array of element addresses
     * @return threshold The number of element signatures needed
     */
    function elementsAndThreshold(bytes calldata _message)
        internal
        view
        returns (address[] memory, uint8)
    {
        uint32 _origin = _message.origin();
        return _sets[_origin].valuesAndThreshold();
    }
}
