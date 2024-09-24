echo "Started building SDK"

yarn build

echo "Finished building SDK"

cd ../cli

echo "Started building CLI"

yarn && yarn build

echo "Finished building CLI"

cd ../sdk