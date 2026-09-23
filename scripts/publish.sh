docker build . -t oci.smeago.com:5000/deck-curator
docker push oci.smeago.com:5000/deck-curator
kubectl rollout restart deployment deck-curator-deployment