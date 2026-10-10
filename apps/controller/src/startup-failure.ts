import { KubernetesApiUnavailableError } from "./drivers/kubernetes/client.ts";

/**
 * Log fields for a startup failure caused by an unreachable dependency, naming
 * the dependency class in `code` and its address in `host` and `port`.
 */
export function startupDependencyFailure(
  error: unknown,
): { readonly code: string; readonly host: string; readonly port: number } | undefined {
  if (error instanceof KubernetesApiUnavailableError) {
    return { code: "KUBERNETES_API_UNAVAILABLE", host: error.host, port: error.port };
  }
  return undefined;
}
