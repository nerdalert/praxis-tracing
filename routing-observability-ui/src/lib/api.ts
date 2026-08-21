import type { Capabilities, Provider, RequestItem, Status } from "./types";

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok)
    throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}
async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}
export const api = {
  status: () => get<Status>("/api/status"),
  capabilities: () => get<Capabilities>("/api/v1/capabilities"),
  requests: (limit = 50) =>
    get<{ requests?: RequestItem[]; items?: RequestItem[] }>(
      `/api/v1/requests?limit=${limit}`,
    ),
  traces: () => get<{ traces?: RequestItem[] }>("/api/traces"),
  providers: () =>
    get<{ providers?: Provider[]; mode?: string }>("/api/providers"),
  overlay: () => get<Record<string, unknown>>("/api/overlay"),
  timing: () => get<Record<string, unknown>>("/api/timing"),
  source: () => get<{ source?: string; data_source?: string }>("/api/source"),
  setSource: (source: string) => post("/api/source", { source }),
  scenario: (name: string) => post(`/api/scenario/${name}`),
  generate: (body: unknown) => post("/api/generate", body),
  cancel: () => post("/api/generate/cancel"),
  tokenStatus: () => get<Record<string, unknown>>("/api/v1/token-rate-limit"),
  tokenRequest: (consumer: "a" | "b", app?: string, tokens?: number) =>
    post("/api/v1/token-rate-limit/requests", { consumer, app, tokens }),
  clearTokenResults: () =>
    fetch("/api/v1/token-rate-limit/requests", { method: "DELETE" }).then((r) =>
      r.json(),
    ),
};
