import app from "./index";
import { handleCurrentObservations } from "./current-observations";
import { importAuthorizationDenial } from "./import-auth";
import { handleOperationalFindings } from "./operational-findings";
import { handleSemanticEstate } from "./semantic-estate";
import { handleSemanticEstateRead } from "./semantic-estate-read";
import { handleSemanticImport } from "./semantic-import";
import { handleSemanticRoutes } from "./semantic-routes";

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_IMPORT_TOKEN?: string;
}

const EVIDENCE_CHUNK_CHARS = 250_000;

function splitEvidence(content: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < content.length; offset += EVIDENCE_CHUNK_CHARS) {
    chunks.push(content.slice(offset, offset + EVIDENCE_CHUNK_CHARS));
  }
  return chunks.length ? chunks : [""];
}

function d1EvidenceBucket(db: D1Database): R2Bucket {
  return {
    async put(key: string, value: unknown, options?: { customMetadata?: Record<string, string> }) {
      const content = typeof value === "string" ? value : JSON.stringify(value);
      const chunks = splitEvidence(content);
      const now = new Date().toISOString();

      await db.batch([
        db.prepare("DELETE FROM topology_evidence_chunk WHERE evidence_key = ?").bind(key),
        db.prepare(
          `INSERT OR REPLACE INTO topology_evidence
           (evidence_key, content_json, metadata_json, created_at)
           VALUES (?, ?, ?, ?)`
        ).bind(
          key,
          `__chunked__:${chunks.length}`,
          JSON.stringify({
            ...(options?.customMetadata ?? {}),
            storage: "d1-chunked",
            chunk_count: String(chunks.length),
            character_count: String(content.length),
          }),
          now,
        ),
      ]);

      for (let offset = 0; offset < chunks.length; offset += 50) {
        await db.batch(
          chunks.slice(offset, offset + 50).map((chunk, index) =>
            db.prepare(
              `INSERT INTO topology_evidence_chunk
               (evidence_key, chunk_index, content_text)
               VALUES (?, ?, ?)`
            ).bind(key, offset + index, chunk)
          )
        );
      }

      return null as never;
    },
  } as unknown as R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;

    // This release is additive. Until ADMIN_IMPORT_TOKEN is configured the
    // pre-existing v1 importer keeps today's behavior; once configured, both
    // old and new write paths share the same administrative credential.
    if (request.method === "POST" && path === "/api/v1/topology/import") {
      const denial = await importAuthorizationDenial(request, env.ADMIN_IMPORT_TOKEN, true);
      if (denial) return denial;
    }

    const semanticImport = await handleSemanticImport(request, {
      DB: env.DB,
      ADMIN_IMPORT_TOKEN: env.ADMIN_IMPORT_TOKEN,
    });
    if (semanticImport) return semanticImport;

    const currentObservations = await handleCurrentObservations(request, {
      DB: env.DB,
      ADMIN_IMPORT_TOKEN: env.ADMIN_IMPORT_TOKEN,
    });
    if (currentObservations) return currentObservations;

    const operationalFindings = await handleOperationalFindings(request, {
      DB: env.DB,
      ADMIN_IMPORT_TOKEN: env.ADMIN_IMPORT_TOKEN,
    });
    if (operationalFindings) return operationalFindings;

    const semanticRoutes = await handleSemanticRoutes(request, { DB: env.DB });
    if (semanticRoutes) return semanticRoutes;

    const semanticEstateRead = await handleSemanticEstateRead(request, { DB: env.DB });
    if (semanticEstateRead) return semanticEstateRead;

    const semanticEstate = await handleSemanticEstate(request, {
      DB: env.DB,
      ADMIN_IMPORT_TOKEN: env.ADMIN_IMPORT_TOKEN,
    });
    if (semanticEstate) return semanticEstate;

    return app.fetch(request, {
      DB: env.DB,
      ASSETS: env.ASSETS,
      EVIDENCE: d1EvidenceBucket(env.DB),
    });
  },
} satisfies ExportedHandler<Env>;
