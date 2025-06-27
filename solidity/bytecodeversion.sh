#!/bin/sh

FILEPATH="contracts/PackageVersioned.sol"
TEMPFILE=$(mktemp)

# writes all but the last 2 lines to the temp file
head -n $(($(wc -l < $FILEPATH) - 2)) $FILEPATH > $TEMPFILE

# writes generated last 2 lines to the temp file
cat <<EOF >> $TEMPFILE
    string public constant PACKAGE_VERSION = "$npm_package_version";
}
EOF

# overwrite the original file with the temp file
cat $TEMPFILE > $FILEPATH

# Update core-utils/index.ts as well
FILEPATH2="core-utils/index.ts"
TEMPFILE2=$(mktemp)

# writes all but the last 2 lines to the temp file
head -n $(($(wc -l < $FILEPATH2) - 2)) $FILEPATH2 > $TEMPFILE2

# writes generated last 2 lines to the temp file
cat <<EOF >> $TEMPFILE2
// GENERATED CODE - DO NOT EDIT
export const CONTRACTS_PACKAGE_VERSION = '$npm_package_version';
EOF

# overwrite the original file with the temp file
cat $TEMPFILE2 > $FILEPATH2
