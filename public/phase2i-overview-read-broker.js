const PHASE2I_READ_BROKER_REVISION = "20260911-1";
const PHASE2I_FINDINGS_TTL_MS = 30_000;
const PHASE2I_COMMON_TTL_MS = 30_000;
const PHASE2I_ESTATE_SUMMARY_TTL_MS = 300_000;
const PHASE2I_FINDING_PAGE_SIZE = 200;
const PHASE2I_MAX_FINDING_PAGES = 100;

// Overview is assembled by several compatibility layers. Without coordination,
// those layers ask D1-backed APIs for the same current facts independently.
// This broker is deliberately narrow: it only coalesces idempotent Overview GETs
// whose response semantics can be reproduced exactly from a bounded current-state
// snapshot. All other fetches pass through unchanged.
const phase2iOriginalFetch = window.fetch.bind(window);
const phase2iResponseCache = new Map();
const phase2iFindingCache = new Map();

function phase2iAbortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

function phase2iSignal(input, init) {
  return init?.signal || (input instanceof Request ? input.signal : null);
}

function phase2iWithAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(phase2iAbortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(phase2iAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function phase2iUrl(input) {
  try {
    if (input instanceof Request) return new URL(input.url, window.location?.href || "http://localhost/");
    return new URL(String(input), window.location?.href || "http://localhost/");
  } catch {
    return null;
  }
}

function phase2iMethod(input, init) {
  return String(init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
}

async function phase2iMaterialize(response) {
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
    body: await response.arrayBuffer(),
  };
}

function phase2iResponse(materialized) {
  return new Response(materialized.body.slice(0), {
    status: materialized.status,
    statusText: materialized.statusText,
    headers: materialized.headers,
  });
}

function phase2iInvalidate() {
  phase2iResponseCache.clear();
  phase2iFindingCache.clear();
}

async function phase2iCachedResponse(key, ttlMs, loader, signal) {
  const now = Date.now();
  const existing = phase2iResponseCache.get(key);
  if (existing?.value && existing.expiresAt > now) {
    return phase2iResponse(existing.value);
  }
  if (existing?.promise) {
    const value = await phase2iWithAbort(existing.promise, signal);
    return phase2iResponse(value);
  }

  const promise = (async () => {
    const materialized = await phase2iMaterialize(await loader());
    if (materialized.ok) {
      phase2iResponseCache.set(key, { value: materialized, expiresAt: Date.now() + ttlMs });
    } else {
      phase2iResponseCache.delete(key);
    }
    return materialized;
  })().catch((error) => {
    phase2iResponseCache.delete(key);
    throw error;
  });
  phase2iResponseCache.set(key, { promise, expiresAt: 0 });
  const value = await phase2iWithAbort(promise, signal);
  return phase2iResponse(value);
}

async function phase2iLoadAllFindings(status) {
  const now = Date.now();
  const existing = phase2iFindingCache.get(status);
  if (existing?.value && existing.expiresAt > now) return existing.value;
  if (existing?.promise) return existing.promise;

  const promise = (async () => {
    const findings = [];
    let offset = 0;
    let schemaVersion = "osi.findings.read/v1";
    for (let page = 0; page < PHASE2I_MAX_FINDING_PAGES; page += 1) {
      const params = new URLSearchParams({
        status,
        limit: String(PHASE2I_FINDING_PAGE_SIZE),
        offset: String(offset),
      });
      const response = await phase2iOriginalFetch(`/api/v2/findings/current?${params}`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        return { error: await phase2iMaterialize(response) };
      }
      const body = await response.json();
      schemaVersion = body?.schema_version || schemaVersion;
      findings.push(...(body?.findings || []));
      const next = body?.page?.next_offset;
      if (next == null) {
        const value = { schemaVersion, findings };
        phase2iFindingCache.set(status, { value, expiresAt: Date.now() + PHASE2I_FINDINGS_TTL_MS });
        return value;
      }
      offset = Number(next);
      if (!Number.isFinite(offset) || offset < 0) break;
    }
    throw new Error(`Overview finding snapshot exceeded ${PHASE2I_MAX_FINDING_PAGES} pages for ${status}`);
  })().catch((error) => {
    phase2iFindingCache.delete(status);
    throw error;
  });

  phase2iFindingCache.set(status, { promise, expiresAt: 0 });
  return promise;
}

function phase2iEligibleFindingRequest(url) {
  if (url.pathname !== "/api/v2/findings/current") return false;
  const allowed = new Set(["status", "severity", "limit", "offset"]);
  for (const key of url.searchParams.keys()) if (!allowed.has(key)) return false;
  const status = url.searchParams.get("status") || "";
  return status === "OPEN" || status === "ACKNOWLEDGED";
}

async function phase2iFindingResponse(url, signal) {
  const status = url.searchParams.get("status") || "";
  const snapshot = await phase2iWithAbort(phase2iLoadAllFindings(status), signal);
  if (snapshot.error) return phase2iResponse(snapshot.error);

  const severity = url.searchParams.get("severity") || "";
  const requestedLimit = Number(url.searchParams.get("limit") || 50);
  const requestedOffset = Number(url.searchParams.get("offset") || 0);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, PHASE2I_FINDING_PAGE_SIZE) : 50;
  const offset = Number.isInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
  const filtered = severity
    ? snapshot.findings.filter((finding) => String(finding?.severity || "") === severity)
    : snapshot.findings;
  const findings = filtered.slice(offset, offset + limit);
  const nextOffset = offset + findings.length < filtered.length ? offset + findings.length : null;
  return new Response(JSON.stringify({
    schema_version: snapshot.schemaVersion,
    page: { total: filtered.length, limit, offset, next_offset: nextOffset },
    findings,
  }, null, 2), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "x-osi-read-broker": PHASE2I_READ_BROKER_REVISION },
  });
}

window.fetch = async function phase2iOverviewFetch(input, init = {}) {
  const method = phase2iMethod(input, init);
  const url = phase2iUrl(input);
  if (!url || url.origin !== window.location.origin) return phase2iOriginalFetch(input, init);

  // Any API mutation can change the current projections. Do not allow a cached
  // read to hide an operator acknowledgement, import, or activation.
  if (method !== "GET") {
    if (url.pathname.startsWith("/api/v2/")) phase2iInvalidate();
    return phase2iOriginalFetch(input, init);
  }

  const signal = phase2iSignal(input, init);
  if (phase2iEligibleFindingRequest(url)) return phase2iFindingResponse(url, signal);

  const key = `${url.pathname}${url.search}`;
  if (url.pathname === "/api/v2/operations/status" && !url.search) {
    return phase2iCachedResponse(key, PHASE2I_COMMON_TTL_MS, () => phase2iOriginalFetch(input, { ...init, signal: undefined }), signal);
  }
  if (url.pathname === "/api/v2/operations/current/observations"
      && url.searchParams.get("limit") === "1"
      && (url.searchParams.get("offset") || "0") === "0"
      && [...url.searchParams.keys()].every((item) => item === "limit" || item === "offset")) {
    return phase2iCachedResponse(key, PHASE2I_COMMON_TTL_MS, () => phase2iOriginalFetch(input, { ...init, signal: undefined }), signal);
  }
  if (url.pathname === "/api/v2/estate/current/summary" && !url.search) {
    return phase2iCachedResponse(key, PHASE2I_ESTATE_SUMMARY_TTL_MS, () => phase2iOriginalFetch(input, { ...init, signal: undefined }), signal);
  }
  return phase2iOriginalFetch(input, init);
};

window.osiInvalidateOverviewReadBroker = phase2iInvalidate;
