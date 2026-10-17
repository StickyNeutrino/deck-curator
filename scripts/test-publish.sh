#!/usr/bin/env bash
# Build and push the image before touching the cluster: a failed build must
# never restart the deployment onto whatever stale image the registry last
# held. `set -e` stops the script on the first failing step; `pipefail` makes
# the image-compress step's failure fail the build too.
set -euo pipefail

IMAGE=oci.smeago.com:5000/test-deck-curator

docker build . -t "$IMAGE"
docker push "$IMAGE"

kubectl apply -f k8s/deck-curator-testing-deployment.yaml
kubectl apply -f k8s/deck-curator-testing-service.yaml
kubectl apply -f k8s/deck-curator-testing-ingress.yaml

kubectl rollout restart deployment deck-curator-testing
# Don't report success until the new pods are actually up and passing their
# readiness probe — a green exit means the new image is being served.
kubectl rollout status deployment deck-curator-testing
