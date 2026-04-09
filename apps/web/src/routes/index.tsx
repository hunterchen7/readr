import { createFileRoute, Navigate } from "@tanstack/react-router";
import { getToken } from "@/lib/api";

export const Route = createFileRoute("/")({
  component: () => {
    const token = getToken();
    return <Navigate to={token ? "/library" : "/login"} />;
  },
});
