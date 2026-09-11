export const title = (value: unknown) =>
  /^llm-d-[a-z0-9-]+$/i.test(String(value ?? ""))
    ? String(value)
    : String(value ?? "—")
        .replaceAll("-", " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
export const time = (value: unknown) =>
  value
    ? new Date(String(value)).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";
export const statusText = (item: any) =>
  item.status ?? item.http?.status ?? "—";
export const providerText = (item: any) =>
  item.inference_provider ?? item.route?.inference_provider ?? item.provider ?? item.route?.provider_gateway ?? "No provider";
export const evidenceClass = (mode: unknown): string =>
  String(mode ?? "")
    .toLowerCase()
    .includes("live")
    ? "live"
    : String(mode ?? "")
          .toLowerCase()
          .includes("sim") ||
        String(mode ?? "")
          .toLowerCase()
          .includes("demo")
      ? "simulation"
      : String(mode ?? "")
            .toLowerCase()
            .includes("unavailable")
        ? "unavailable"
        : "unknown";
