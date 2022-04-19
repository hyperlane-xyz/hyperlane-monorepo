TAG=$1
if [[ -z $TAG ]]; then
  TAG=$(git rev-parse HEAD)
  echo "Defaulting to tag $TAG"

  if [[ ! -z $(git status -s) ]]; then
    echo "Note there are uncommitted changes"
  fi
fi

DOCKER_BUILDKIT=1 docker build -t gcr.io/abacus-labs-dev/abacus-agent:$TAG .

