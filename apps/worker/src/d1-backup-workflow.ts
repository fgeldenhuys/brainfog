import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";

type D1ExportApiResponse = {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: {
    at_bookmark?: string;
    status?: "active" | "complete" | "error";
    error?: string;
    result?: {
      filename?: string;
      signed_url?: string;
    };
  } | null;
};

type ExportComplete = {
  atBookmark: string;
  filename: string;
  signedUrl: string;
};

type BackupResult = {
  key: string;
  filename: string;
  atBookmark: string;
};

type BackupConfig = {
  accountId: string;
  databaseId: string;
  apiToken: string;
};

type BackupStep = {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T>(name: string, config: unknown, callback: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: string | number): Promise<void>;
};

const D1_EXPORT_POLL_LIMIT = 120;
const D1_EXPORT_POLL_DELAY = "30 seconds";

function readBackupConfig(env: Env): BackupConfig {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const databaseId = env.D1_DATABASE_ID?.trim();
  const apiToken = env.D1_REST_API_TOKEN?.trim();

  if (!accountId) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID is required for D1 backups");
  }
  if (!databaseId) {
    throw new Error("D1_DATABASE_ID is required for D1 backups");
  }
  if (!apiToken) {
    throw new Error("D1_REST_API_TOKEN is required for D1 backups");
  }

  return { accountId, databaseId, apiToken };
}

function exportEndpoint(config: BackupConfig): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
    config.accountId,
  )}/d1/database/${encodeURIComponent(config.databaseId)}/export`;
}

async function postD1Export(
  config: BackupConfig,
  body: Record<string, string>,
  fetcher: typeof fetch,
): Promise<D1ExportApiResponse> {
  const response = await fetcher(exportEndpoint(config), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const payload = (await response.json()) as D1ExportApiResponse;
  if (!response.ok || payload.success === false) {
    const message =
      payload.errors?.map((error) => error.message).join("; ") ||
      `D1 export API returned HTTP ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

function requireAtBookmark(payload: D1ExportApiResponse): string {
  const atBookmark = payload.result?.at_bookmark;
  if (!atBookmark) {
    throw new Error("D1 export response did not include at_bookmark");
  }
  return atBookmark;
}

async function startD1Export(config: BackupConfig, fetcher: typeof fetch): Promise<string> {
  const payload = await postD1Export(config, { output_format: "polling" }, fetcher);
  return requireAtBookmark(payload);
}

async function pollD1Export(
  config: BackupConfig,
  atBookmark: string,
  fetcher: typeof fetch,
): Promise<ExportComplete | null> {
  const payload = await postD1Export(
    config,
    { output_format: "polling", current_bookmark: atBookmark },
    fetcher,
  );
  const confirmedBookmark = requireAtBookmark(payload);

  if (payload.result?.status === "error") {
    throw new Error(payload.result.error || "D1 export failed");
  }
  if (payload.result?.status !== "complete") {
    return null;
  }

  const filename = payload.result.result?.filename;
  const signedUrl = payload.result.result?.signed_url;
  if (!signedUrl) {
    throw new Error("D1 export completed without signed_url");
  }

  return {
    atBookmark: confirmedBookmark,
    filename: filename || fallbackFilename(new Date()),
    signedUrl,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function fallbackFilename(timestamp: Date): string {
  return `${timestamp.toISOString().replace(/[:.]/g, "-")}.sql`;
}

export function buildD1BackupKey(timestamp: Date, filename: string): string {
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_") || fallbackFilename(timestamp);
  return [
    "d1",
    "brainfog",
    String(timestamp.getUTCFullYear()),
    pad(timestamp.getUTCMonth() + 1),
    pad(timestamp.getUTCDate()),
    safeFilename.endsWith(".sql") ? safeFilename : `${safeFilename}.sql`,
  ].join("/");
}

async function writeDumpToR2(
  backupBucket: R2Bucket,
  signedUrl: string,
  key: string,
  fetcher: typeof fetch,
): Promise<void> {
  const response = await fetcher(signedUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download D1 export dump: HTTP ${response.status}`);
  }

  await backupBucket.put(key, response.body, {
    httpMetadata: { contentType: "application/sql" },
  });
}

export async function runD1Backup(
  env: Env,
  step: BackupStep,
  timestamp: Date,
  fetcher: typeof fetch = fetch,
): Promise<BackupResult> {
  const config = readBackupConfig(env);
  const atBookmark = await step.do(
    "start D1 SQL export",
    { retries: { limit: 3, delay: "10 seconds" } },
    () => startD1Export(config, fetcher),
  );

  let completed: ExportComplete | null = null;
  for (let poll = 1; poll <= D1_EXPORT_POLL_LIMIT; poll += 1) {
    completed = await step.do(`poll D1 SQL export ${poll}`, () =>
      pollD1Export(config, atBookmark, fetcher),
    );
    if (completed) {
      break;
    }
    await step.sleep(`wait before D1 SQL export poll ${poll + 1}`, D1_EXPORT_POLL_DELAY);
  }

  if (!completed) {
    throw new Error("D1 export did not complete before the polling limit");
  }

  const key = buildD1BackupKey(timestamp, completed.filename);
  await step.do(
    "store D1 SQL export in R2",
    { retries: { limit: 5, delay: "30 seconds", backoff: "exponential" }, timeout: "10 minutes" },
    async () => {
      await writeDumpToR2(env.D1_BACKUPS, completed.signedUrl, key, fetcher);
      return { key };
    },
  );

  return { key, filename: completed.filename, atBookmark: completed.atBookmark };
}

export class D1BackupWorkflow extends WorkflowEntrypoint<Env> {
  async run(event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep): Promise<BackupResult> {
    return runD1Backup(this.env, step, event.timestamp);
  }
}
