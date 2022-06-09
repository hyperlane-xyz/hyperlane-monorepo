TAG=$1
USE_DEFAULT_PLATFORM=$2
if [[ -z $TAG ]]; then
  TAG="sha-$(git rev-parse --short HEAD)"
  echo "Defaulting to tag $TAG"

  if [[ ! -z $(git status -s) ]]; then
    echo "Note there are uncommitted changes"
  fi

  # Apple M1 chips by default will build for arm64, which isn't compatible
  # with our K8s setup. By manually building for amd64, we build an image
  # compatible with our K8s infrastructure.
  # More info: https://stackoverflow.com/a/71102144
  if [[ $USE_DEFAULT_PLATFORM != "true" ]]; then
    PLATFORM="--platform=linux/amd64"
  fi
fi

DOCKER_BUILDKIT=1 docker build $PLATFORM -t gcr.io/abacus-labs-dev/abacus-agent:$TAG .
