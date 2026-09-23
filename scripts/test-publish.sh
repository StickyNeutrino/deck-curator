kubectl apply -f k8s/deck-curator-testing-deployment.yaml
kubectl apply -f k8s/deck-curator-testing-service.yaml
kubectl apply -f k8s/deck-curator-testing-ingress.yaml
docker build . -t oci.smeago.com:5000/test-deck-curator
docker push oci.smeago.com:5000/test-deck-curator
kubectl rollout restart deployment deck-curator-testing