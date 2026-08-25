// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.4.23;

contract DSTest {
    event log                    (string);
    event logs                   (bytes);

    event log_address            (address);
    event log_bytes32            (bytes32);
    event log_int                (int);
    event log_uint               (uint);
    event log_bytes              (bytes);
    event log_string             (string);

    event log_named_address      (string key, address val);
    event log_named_bytes32      (string key, bytes32 val);
    event log_named_decimal_int  (string key, int val, uint decimals);
    event log_named_decimal_uint (string key, uint val, uint decimals);
    event log_named_int          (string key, int val);
    event log_named_uint         (string key, uint val);
    event log_named_bytes        (string key, bytes val);
    event log_named_string       (string key, string val);

    bool public IS_TEST = true;
    bool private _failed;

    function failed() public view returns (bool) {
        return _failed;
    }

    function fail() internal virtual {
        _failed = true;
    }

    function assertTrue(bool condition) internal virtual {
        if (!condition) {
            emit log("Error: Assertion Failed");
            fail();
        }
    }

    function assertTrue(bool condition, string memory err) internal virtual {
        if (!condition) {
            emit log_named_string("Error", err);
            fail();
        }
    }

    function assertEq0(bytes memory a, bytes memory b) internal virtual {
        if (keccak256(a) != keccak256(b)) {
            emit log("Error: a == b not satisfied [bytes]");
            emit log_named_bytes("  Expected", b);
            emit log_named_bytes("    Actual", a);
            fail();
        }
    }

    function assertEq0(bytes memory a, bytes memory b, string memory err) internal virtual {
        if (keccak256(a) != keccak256(b)) {
            emit log_named_string("Error", err);
            emit log_named_bytes("  Expected", b);
            emit log_named_bytes("    Actual", a);
            fail();
        }
    }

    function assertEq(address a, address b) internal virtual {
        if (a != b) {
            emit log("Error: a == b not satisfied [address]");
            emit log_named_address("  Expected", b);
            emit log_named_address("    Actual", a);
            fail();
        }
    }

    function assertEq(address a, address b, string memory err) internal virtual {
        if (a != b) {
            emit log_named_string("Error", err);
            emit log_named_address("  Expected", b);
            emit log_named_address("    Actual", a);
            fail();
        }
    }

    function assertEq(bytes32 a, bytes32 b) internal virtual {
        if (a != b) {
            emit log("Error: a == b not satisfied [bytes32]");
            emit log_named_bytes32("  Expected", b);
            emit log_named_bytes32("    Actual", a);
            fail();
        }
    }

    function assertEq(bytes32 a, bytes32 b, string memory err) internal virtual {
        if (a != b) {
            emit log_named_string("Error", err);
            emit log_named_bytes32("  Expected", b);
            emit log_named_bytes32("    Actual", a);
            fail();
        }
    }

    function assertEq(uint256 a, uint256 b) internal virtual {
        if (a != b) {
            emit log("Error: a == b not satisfied [uint]");
            emit log_named_uint("  Expected", b);
            emit log_named_uint("    Actual", a);
            fail();
        }
    }

    function assertEq(uint256 a, uint256 b, string memory err) internal virtual {
        if (a != b) {
            emit log_named_string("Error", err);
            emit log_named_uint("  Expected", b);
            emit log_named_uint("    Actual", a);
            fail();
        }
    }

    function assertEq(int256 a, int256 b) internal virtual {
        if (a != b) {
            emit log("Error: a == b not satisfied [int]");
            emit log_named_int("  Expected", b);
            emit log_named_int("    Actual", a);
            fail();
        }
    }

    function assertEq(string memory a, string memory b) internal virtual {
        if (keccak256(abi.encodePacked(a)) != keccak256(abi.encodePacked(b))) {
            emit log("Error: a == b not satisfied [string]");
            emit log_named_string("  Expected", b);
            emit log_named_string("    Actual", a);
            fail();
        }
    }

    function assertGt(uint256 a, uint256 b) internal virtual {
        if (a <= b) {
            emit log("Error: a > b not satisfied [uint]");
            emit log_named_uint("  Expected: >", b);
            emit log_named_uint("    Actual:  ", a);
            fail();
        }
    }

    function assertGe(uint256 a, uint256 b) internal virtual {
        if (a < b) {
            emit log("Error: a >= b not satisfied [uint]");
            emit log_named_uint("  Expected: >=", b);
            emit log_named_uint("    Actual:  ", a);
            fail();
        }
    }

    function assertLt(uint256 a, uint256 b) internal virtual {
        if (a >= b) {
            emit log("Error: a < b not satisfied [uint]");
            emit log_named_uint("  Expected: <", b);
            emit log_named_uint("    Actual:  ", a);
            fail();
        }
    }

    function assertLe(uint256 a, uint256 b) internal virtual {
        if (a > b) {
            emit log("Error: a <= b not satisfied [uint]");
            emit log_named_uint("  Expected: <=", b);
            emit log_named_uint("    Actual:  ", a);
            fail();
        }
    }
}
