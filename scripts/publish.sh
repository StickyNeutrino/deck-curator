kubectl apply -f k8s/deck-curator-deployment.yaml
kubectl apply -f k8s/deck-curator-service.yaml
kubectl apply -f k8s/deck-curator-ingress.yaml
docker build . -t oci.smeago.com:5000/deck-curator
docker push oci.smeago.com:5000/deck-curator
kubectl rollout restart deployment deck-curator-deployment