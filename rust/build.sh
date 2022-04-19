TAG=$1
if [[ -z $TAG ]]; then
  TAG=$(git rev-parse HEAD)
  echo "Defaulting to tag $TAG"

  if [[ ! -z $(git status -s) ]]; then
    echo "Note there are uncommitted changes"
  fi
fi

docker build -t gcr.io/clabs-optics/optics-agent:$TAG .

