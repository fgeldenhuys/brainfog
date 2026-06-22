import { describe, expect, it } from "vitest";
import { buildD1BackupKey, runD1Backup } from "../src/d1-backup-workflow";
import type { Env } from "../src/env";

type StoredObject = {
  key: string;
  body: string;
  contentType?: string;
};

function createStep() {
  const names: string[] = [];
  return {
    names,
    async do<T>(
      name: string,
      configOrCallback: unknown,
      maybeCallback?: () => Promise<T>,
    ): Promise<T> {
      names.push(name);
      const callback = (
        typeof configOrCallback === "function" ? configOrCallback : maybeCallback
      ) as (() => Promise<T>) | undefined;
      if (!callback) {
        throw new Error(`Missing callback for step ${name}`);
      }
      return callback();
    },
    async sleep(name: string): Promise<void> {
      names.push(name);
    },
  };
}

function createEnv(stored: StoredObject[]): Env {
  return {
    CLOUDFLARE_ACCOUNT_ID: "account-id",
    D1_DATABASE_ID: "database-id",
    D1_REST_API_TOKEN: "api-token",
    D1_BACKUPS: {
      async put(key: string, value: ReadableStream, options?: R2PutOptions): Promise<R2Object> {
        const httpMetadata = options?.httpMetadata as R2HTTPMetadata | undefined;
        stored.push({
          key,
          body: await new Response(value).text(),
          contentType: httpMetadata?.contentType,
        });
        return { key } as R2Object;
      },
    } as R2Bucket,
  } as Env;
}

describe("D1 backup workflow logic", () => {
  it("starts a D1 export and polls with the returned at_bookmark", async () => {
    const stored: StoredObject[] = [];
    const requests: Array<{ url: string; body?: Record<string, string>; authorization?: string }> =
      [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://api.cloudflare.com")) {
        requests.push({
          url,
          body: JSON.parse(String(init?.body)) as Record<string, string>,
          authorization: new Headers(init?.headers).get("authorization") ?? undefined,
        });
        if (requests.length === 1) {
          return Response.json(
            { success: true, result: { at_bookmark: "bookmark-1", status: "active" } },
            { status: 202 },
          );
        }
        return Response.json({
          success: true,
          result: {
            at_bookmark: "bookmark-1",
            status: "complete",
            result: { filename: "brainfog.sql", signed_url: "https://signed.example/dump.sql" },
          },
        });
      }
      return new Response("-- sql dump");
    };

    const result = await runD1Backup(
      createEnv(stored),
      createStep(),
      new Date("2026-06-18T02:00:00Z"),
      fetcher,
    );

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-id/d1/database/database-id/export",
    );
    expect(requests[0]?.authorization).toBe("Bearer api-token");
    expect(requests[0]?.body).toEqual({ output_format: "polling" });
    expect(requests[1]?.body).toEqual({ output_format: "polling", current_bookmark: "bookmark-1" });
    expect(result).toEqual({
      key: "d1/brainfog/2026/06/18/brainfog.sql",
      filename: "brainfog.sql",
      atBookmark: "bookmark-1",
    });
  });

  it("writes the completed SQL dump body to the dedicated backup bucket", async () => {
    const stored: StoredObject[] = [];
    const fetcher: typeof fetch = async (input) => {
      if (String(input).startsWith("https://api.cloudflare.com")) {
        return Response.json({
          success: true,
          result: {
            at_bookmark: "bookmark-2",
            status: "complete",
            result: {
              filename: "manual export.sql",
              signed_url: "https://signed.example/dump.sql",
            },
          },
        });
      }
      return new Response("CREATE TABLE users(id TEXT);");
    };

    await runD1Backup(createEnv(stored), createStep(), new Date("2026-01-04T02:00:00Z"), fetcher);

    expect(stored).toEqual([
      {
        key: "d1/brainfog/2026/01/04/manual_export.sql",
        body: "CREATE TABLE users(id TEXT);",
        contentType: "application/sql",
      },
    ]);
  });

  it("fails before polling when the start response omits at_bookmark", async () => {
    const fetcher: typeof fetch = async () =>
      Response.json({ success: true, result: { status: "active" } }, { status: 202 });

    await expect(
      runD1Backup(createEnv([]), createStep(), new Date("2026-06-18T02:00:00Z"), fetcher),
    ).rejects.toThrow("at_bookmark");
  });

  it("builds deterministic timestamped backup keys", () => {
    expect(buildD1BackupKey(new Date("2026-06-18T02:00:00Z"), "brainfog export")).toBe(
      "d1/brainfog/2026/06/18/brainfog_export.sql",
    );
  });
});
