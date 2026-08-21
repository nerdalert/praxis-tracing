export type Evidence = "live" | "simulation" | "unavailable";
export type Provider = {
  id?: string;
  name?: string;
  site?: string;
  cluster?: string;
  score?: number | null;
  rank?: number | null;
  pressure?: string;
  status?: string;
  queue_depth?: { value?: number | null; raw_value?: number | null };
  kv_cache?: { value?: number | null };
};
export type RequestItem = {
  request_id?: string;
  id?: string;
  started_at?: string;
  timestamp?: string;
  status?: number;
  http?: { status?: number };
  provider?: string;
  route?: { provider_gateway?: string; hops?: string[] };
  trace_id?: string | null;
  trace?: { trace_id?: string | null };
  experience?: string;
  score?: number | null;
  rank?: number | null;
  source?: string;
  mode?: string;
  [key: string]: unknown;
};
export type Status = {
  mode?: string;
  evidence?: Evidence;
  source?: string;
  source_label?: string;
  data_source?: string;
  live_detail?: unknown;
  [key: string]: unknown;
};
export type Capabilities = {
  version?: string;
  environment?: { profile?: string; display_name?: string; [key: string]: unknown };
  [key: string]: unknown;
};
