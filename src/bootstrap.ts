import app from "./index";

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

function d1EvidenceBucket(db: D1Database): R2Bucket {
  return {
    async put(key: string, value: unknown, options?: { customMetadata?: Record<string, string> }) {
      const content = typeof value === "string" ? value : JSON.stringify(value);
      await db.prepare(
        `INSERT OR REPLACE INTO topology_evidence
         (evidence_key, content_json, metadata_json, created_at)
         VALUES (?, ?, ?, ?)`
      ).bind(
        key,
        content,
        JSON.stringify(options?.customMetadata ?? {}),
        new Date().toISOString(),
      ).run();
      return null as never;
    },
  } as unknown as R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return app.fetch(request, {
      DB: env.DB,
      ASSETS: env.ASSETS,
      EVIDENCE: d1EvidenceBucket(env.DB),
    });
  },
} satisfies ExportedHandler<Env>;
