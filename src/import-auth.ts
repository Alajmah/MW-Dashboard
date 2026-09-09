const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function reply(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function equalToken(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a[index] ^ b[index];
  return diff === 0;
}

/**
 * Return a denial response when an import request is not authorized, otherwise null.
 * `allowWhenUnconfigured` is used only for the pre-existing v1 endpoint during the
 * token rollout so this additive release does not break today's manual import path.
 * As soon as ADMIN_IMPORT_TOKEN is configured, the legacy endpoint is protected too.
 */
export async function importAuthorizationDenial(
  request: Request,
  configuredToken?: string,
  allowWhenUnconfigured = false,
): Promise<Response | null> {
  const expected = configuredToken?.trim();
  if (!expected) {
    return allowWhenUnconfigured
      ? null
      : reply({ detail: "Topology import is disabled until ADMIN_IMPORT_TOKEN is configured" }, 503);
  }

  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match || !(await equalToken(match[1].trim(), expected))) {
    return reply({ detail: "Invalid or missing import authorization" }, 401);
  }
  return null;
}
