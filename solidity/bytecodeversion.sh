#!/bin/bash

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
