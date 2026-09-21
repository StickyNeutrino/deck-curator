import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("project/:projectId", "routes/project.tsx"),
  route("project/:projectId/info", "routes/info.tsx"),
  route("project/:projectId/species/:speciesId", "routes/species.tsx"),
  route("project/:projectId/review", "routes/review.tsx"),
  route("project/:projectId/export", "routes/export.tsx"),
] satisfies RouteConfig;
