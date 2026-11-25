export interface ScheduleDoseClient {
  // GET /v1/patients/{id}/has-dose-records → {hasDoseRecords}; NO cache;
  // throws on any failure — Core maps to DependencyError (fail-closed, FR-MED-017).
  hasDoseRecords(patientId: string): Promise<boolean>;
}

const REQUEST_TIMEOUT_MS = 3_000;
const RETRY_DELAY_MS = 200;

export function createScheduleDoseClient(deps: {
  baseUrl: string;
  mintServiceToken: (aud: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): ScheduleDoseClient {
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function attempt(patientId: string) {
    const token = await deps.mintServiceToken("medo-schedule-dose");
    return fetchImpl(
      `${deps.baseUrl}/v1/patients/${encodeURIComponent(patientId)}/has-dose-records`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  }

  return {
    async hasDoseRecords(patientId) {
      let res: Response | null = null;
      for (let i = 0; i < 2; i++) {
        try {
          res = await attempt(patientId);
          if (res.ok) break;
          if (res.status < 500) break; // permanent — no retry
        } catch {
          res = null;
        }
        if (i === 0) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
      if (!res || !res.ok) {
        throw new Error("schedule-dose has-dose-records unavailable");
      }
      const body = (await res.json()) as { hasDoseRecords?: unknown };
      if (typeof body.hasDoseRecords !== "boolean") {
        throw new Error("has-dose-records malformed response");
      }
      return body.hasDoseRecords;
    },
  };
}
