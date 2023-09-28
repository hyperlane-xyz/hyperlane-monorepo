# generates lcov.info
forge coverage --report lcov

if ! command -v lcov &>/dev/null; then
    echo "lcov is not installed. Installing..."
    sudo apt-get install lcov
else
    echo "lcov is installed."
fi

EXCLUDE="*test* *mock* *node_modules* $(grep -r 'library' contracts -l)" # forge does not instrument libraries
lcov --rc lcov_branch_coverage=1 \
    --output-file forge-pruned-lcov.info \
    --remove lcov.info $EXCLUDE    

if [ "$CI" != "true" ]; then
    genhtml --rc lcov_branch_coverage=1 \
        --output-directory coverage forge-pruned-lcov.info \
        && open coverage/index.html
fi
