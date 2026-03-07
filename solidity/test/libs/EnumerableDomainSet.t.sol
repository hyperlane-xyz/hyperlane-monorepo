// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {EnumerableDomainSet} from "../../contracts/libs/EnumerableDomainSet.sol";

/// @dev Concrete implementation for testing the abstract EnumerableDomainSet
contract TestEnumerableDomainSet is EnumerableDomainSet {
    function addDomain(uint32 _domain) external returns (bool) {
        return _addDomain(_domain);
    }

    function removeDomain(uint32 _domain) external returns (bool) {
        return _removeDomain(_domain);
    }

    function containsDomain(uint32 _domain) external view returns (bool) {
        return _containsDomain(_domain);
    }

    function domainCount() external view returns (uint256) {
        return _domainCount();
    }
}

contract EnumerableDomainSetTest is Test {
    TestEnumerableDomainSet domainSet;

    function setUp() public {
        domainSet = new TestEnumerableDomainSet();
    }

    // ============ Basic Operations ============

    function test_empty_initially() public {
        assertEq(domainSet.domainCount(), 0);
        assertEq(domainSet.domains().length, 0);
    }

    function test_addDomain() public {
        bool added = domainSet.addDomain(1);
        assertTrue(added);
        assertEq(domainSet.domainCount(), 1);
        assertTrue(domainSet.containsDomain(1));
    }

    function test_addDomain_returnsTrue_whenNew() public {
        bool added = domainSet.addDomain(1);
        assertTrue(added);
    }

    function test_addDomain_returnsFalse_whenDuplicate() public {
        domainSet.addDomain(1);
        bool added = domainSet.addDomain(1);
        assertFalse(added);
    }

    function test_addDomain_idempotent() public {
        domainSet.addDomain(1);
        domainSet.addDomain(1);
        domainSet.addDomain(1);
        assertEq(domainSet.domainCount(), 1);
    }

    function test_removeDomain() public {
        domainSet.addDomain(1);
        bool removed = domainSet.removeDomain(1);
        assertTrue(removed);
        assertEq(domainSet.domainCount(), 0);
        assertFalse(domainSet.containsDomain(1));
    }

    function test_removeDomain_returnsFalse_whenNotPresent() public {
        bool removed = domainSet.removeDomain(1);
        assertFalse(removed);
    }

    function test_containsDomain() public {
        assertFalse(domainSet.containsDomain(1));
        domainSet.addDomain(1);
        assertTrue(domainSet.containsDomain(1));
        domainSet.removeDomain(1);
        assertFalse(domainSet.containsDomain(1));
    }

    function test_domains_returnsAllDomains() public {
        domainSet.addDomain(100);
        domainSet.addDomain(200);
        domainSet.addDomain(300);

        uint32[] memory domains = domainSet.domains();
        assertEq(domains.length, 3);

        // Check all domains present (order may vary due to set implementation)
        bool found100;
        bool found200;
        bool found300;
        for (uint256 i = 0; i < domains.length; i++) {
            if (domains[i] == 100) found100 = true;
            if (domains[i] == 200) found200 = true;
            if (domains[i] == 300) found300 = true;
        }
        assertTrue(found100 && found200 && found300);
    }

    function test_domains_afterRemoval() public {
        domainSet.addDomain(100);
        domainSet.addDomain(200);
        domainSet.addDomain(300);
        domainSet.removeDomain(200);

        uint32[] memory domains = domainSet.domains();
        assertEq(domains.length, 2);

        bool found100;
        bool found300;
        for (uint256 i = 0; i < domains.length; i++) {
            if (domains[i] == 100) found100 = true;
            if (domains[i] == 300) found300 = true;
            assertFalse(domains[i] == 200);
        }
        assertTrue(found100 && found300);
    }

    // ============ Edge Cases ============

    function test_addDomain_zero() public {
        bool added = domainSet.addDomain(0);
        assertTrue(added);
        assertTrue(domainSet.containsDomain(0));
    }

    function test_addDomain_maxUint32() public {
        bool added = domainSet.addDomain(type(uint32).max);
        assertTrue(added);
        assertTrue(domainSet.containsDomain(type(uint32).max));
    }

    // ============ Fuzz Tests ============

    function testFuzz_addDomain(uint32 domain) public {
        bool added = domainSet.addDomain(domain);
        assertTrue(added);
        assertTrue(domainSet.containsDomain(domain));
        assertEq(domainSet.domainCount(), 1);
    }

    function testFuzz_addRemoveDomain(uint32 domain) public {
        domainSet.addDomain(domain);
        assertTrue(domainSet.containsDomain(domain));

        domainSet.removeDomain(domain);
        assertFalse(domainSet.containsDomain(domain));
        assertEq(domainSet.domainCount(), 0);
    }

    function testFuzz_multipleDomains(uint32[] memory domains) public {
        vm.assume(domains.length <= 100);

        for (uint256 i = 0; i < domains.length; i++) {
            domainSet.addDomain(domains[i]);
        }

        // Count unique domains
        uint256 uniqueCount = 0;
        for (uint256 i = 0; i < domains.length; i++) {
            bool isDuplicate = false;
            for (uint256 j = 0; j < i; j++) {
                if (domains[j] == domains[i]) {
                    isDuplicate = true;
                    break;
                }
            }
            if (!isDuplicate) uniqueCount++;
        }

        assertEq(domainSet.domainCount(), uniqueCount);
        assertEq(domainSet.domains().length, uniqueCount);
    }

    // ============ Storage Isolation Test ============

    function test_storageIsolation_betweenInstances() public {
        TestEnumerableDomainSet domainSet2 = new TestEnumerableDomainSet();

        domainSet.addDomain(1);
        domainSet2.addDomain(2);

        // Each instance should have its own storage
        assertTrue(domainSet.containsDomain(1));
        assertFalse(domainSet.containsDomain(2));

        assertTrue(domainSet2.containsDomain(2));
        assertFalse(domainSet2.containsDomain(1));
    }

    // ============ EIP-7201 Storage Location Test ============

    function test_storageLocation_matchesEIP7201Formula() public pure {
        // The storage slot should match:
        // keccak256(abi.encode(uint256(keccak256("hyperlane.storage.EnumerableDomainSet")) - 1)) & ~bytes32(uint256(0xff))
        bytes32 innerHash = keccak256("hyperlane.storage.EnumerableDomainSet");
        bytes32 outerHash = keccak256(abi.encode(uint256(innerHash) - 1));
        bytes32 expectedSlot = outerHash & ~bytes32(uint256(0xff));

        bytes32 actualSlot = 0xdcbc515942dd8ef153d6dc57820c8985f8a2facbcec06feacd3986bb6c43ef00;

        assertEq(
            actualSlot,
            expectedSlot,
            "Storage slot does not match EIP-7201 formula"
        );
    }
}
