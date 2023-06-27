forge doc --build

if [ "$CI" != "true" ]
then
    open docs/book/index.html
fi
