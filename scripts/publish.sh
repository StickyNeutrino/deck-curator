#!/usr/bin/env bash
# Build and push the image before touching the cluster: a failed build must
# never restart the deployment onto whatever stale image the registry last
# held. `set -e` stops the script on the first failing step; `pipefail` makes
# the image-compress step's failure fail the build too.
set -euo pipefail

IMAGE=oci.smeago.com:5000/deck-curator

# CI gate first: the full suite runs in a throwaway container (see ci.sh).
# A red run aborts here — nothing reaches the registry, and the cluster
# keeps running whatever image it already had.
#
# SKIP_CI exists for emergencies: a broken suite should not hold a hotfix
# hostage. Set it to any non-empty value to deploy without the gate. The
# bypass is loud so a skipped gate is visible in the deploy log.
if [ -n "${SKIP_CI:-}" ]; then
  echo "SKIP_CI is set — deploying WITHOUT the test gate." >&2
else
  "$(dirname "$0")/ci.sh"
fi

docker build . -t "$IMAGE"
docker push "$IMAGE"

kubectl apply -f k8s/deck-curator-deployment.yaml
kubectl apply -f k8s/deck-curator-service.yaml
kubectl apply -f k8s/deck-curator-ingress.yaml

kubectl rollout restart deployment deck-curator-deployment
# Don't report success until the new pods are actually up and passing their
# readiness probe — a green exit means the new image is being served.
kubectl rollout status deployment deck-curator-deployment
