import { sha256 } from "@noble/hashes/sha256";

import {
  CANONICAL_R2_ORIGIN,
  IMAGE_MAX_BYTES,
  MEDIA_SNIFF_BYTES,
  MULTIPART_PART_BYTES,
  VIDEO_MAX_BYTES,
  MediaIngestionError,
  assertByteLimit,
  byteLimitForMediaType,
  deriveCanonicalKey,
  detectMediaType,
  mediaTypeFromContentType,
  parseCanonicalMediaUrl,
  resolveAndValidateRedirectUrl,
  safeSourceUrlMetadata,
  validateMediaContentType,
  validatePublicHttpsUrl,
} from "./media-ingestion.js";

const MAX_REDIRECTS = 5;
const SOURCE_CONNECT_TIMEOUT_MS = 30_000;
const SOURCE_INACTIVITY_TIMEOUT_MS = 30_000;
const SOURCE_OVERALL_TIMEOUT_MS = 30 * 60 * 1000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SOURCE_HEADERS = Object.freeze({
  Accept:
    "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm,application/octet-stream;q=0.5,*/*;q=0.1",
  "User-Agent": "media-assets-worker/1.0 (+https://images.xhs.justlikekatie.com)",
});

export async function ingestSourceToR2(
  env,
  { sourceUrl, postId = null, kind = null },
  options = {}
) {
  assertR2Config(env);
  assertKind(kind);

  const source = typeof sourceUrl === "string" ? sourceUrl.trim() : "";
  const canonical = parseCanonicalMediaUrl(source, env.R2_PUBLIC_BASE_URL);
  if (canonical) {
    const object = await headCanonicalObject(env.MEDIA_BUCKET, canonical);
    if (!object) {
      throw new MediaIngestionError(
        404,
        "Canonical media URL does not exist in R2.",
        "CANONICAL_OBJECT_MISSING"
      );
    }
    const metadata = validateCanonicalHead(canonical, object);
    assertKindMatches(kind, canonical.mediaType);
    return buildIngestionResult({
      sourceUrl: source,
      canonical,
      size: metadata.size,
      contentType: metadata.contentType,
      action: "reused",
    });
  }

  if (hasCanonicalOrigin(source)) {
    throw new MediaIngestionError(
      400,
      "URL on the canonical media origin does not use a valid canonical key.",
      "INVALID_CANONICAL_URL"
    );
  }

  const initialUrl = validatePublicHttpsUrl(source);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sourceResponse = await fetchSourceWithRedirects(
    initialUrl,
    fetchImpl,
    env.R2_PUBLIC_BASE_URL
  );
  if (sourceResponse.canonical) {
    const object = await headCanonicalObject(
      env.MEDIA_BUCKET,
      sourceResponse.canonical
    );
    if (!object) {
      throw new MediaIngestionError(
        404,
        "Canonical media redirect does not exist in R2.",
        "CANONICAL_OBJECT_MISSING"
      );
    }
    const metadata = validateCanonicalHead(sourceResponse.canonical, object);
    assertKindMatches(kind, sourceResponse.canonical.mediaType);
    return buildIngestionResult({
      sourceUrl: source,
      canonical: sourceResponse.canonical,
      size: metadata.size,
      contentType: metadata.contentType,
      action: "reused",
    });
  }
  const { response, controller } = sourceResponse;

  let uploadId = null;
  let stagingKey = null;
  let multipart = null;
  let multipartCompleted = false;
  let reader = null;
  let primaryError = null;

  try {
    const declaredContentType = response.headers.get("Content-Type") || "";
    const declaredMediaType = mediaTypeFromContentType(declaredContentType);
    const contentLength = parseContentLength(
      response.headers.get("Content-Length")
    );
    assertKindMatches(kind, declaredMediaType);
    precheckContentLength(contentLength, kind, declaredMediaType);

    uploadId = crypto.randomUUID();
    stagingKey = `imports/staging/${uploadId}`;
    multipart = await createMultipartUpload(env.MEDIA_BUCKET, stagingKey);
    reader = response.body?.getReader();
    if (!reader) {
      throw new MediaIngestionError(
        502,
        "Source response did not contain a readable body.",
        "SOURCE_BODY_MISSING"
      );
    }

    const hasher = sha256.create();
    const prefix = new Uint8Array(MEDIA_SNIFF_BYTES);
    const partBuffer = new MultipartPartBuffer(MULTIPART_PART_BYTES);
    const uploadedParts = [];
    const streamStartedAt = Date.now();
    let prefixLength = 0;
    let totalBytes = 0;
    let mediaType = null;
    let storageContentType = null;
    let partNumber = 1;

    const uploadPart = async (bytes) => {
      const part = await multipart.uploadPart(partNumber, bytes);
      uploadedParts.push(part);
      partNumber += 1;
    };

    while (true) {
      const { done, value } = await readSourceChunk(
        reader,
        controller,
        streamStartedAt
      );
      if (done) break;

      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (!chunk.byteLength) continue;

      totalBytes += chunk.byteLength;
      const provisionalLimit = provisionalByteLimit(
        kind,
        mediaType,
        declaredMediaType
      );
      if (totalBytes > provisionalLimit) {
        throw tooLargeError(kind || mediaType?.kind || declaredMediaType?.kind);
      }

      hasher.update(chunk);
      if (prefixLength < prefix.byteLength) {
        const copyLength = Math.min(
          chunk.byteLength,
          prefix.byteLength - prefixLength
        );
        prefix.set(chunk.subarray(0, copyLength), prefixLength);
        prefixLength += copyLength;
      }

      if (!mediaType) {
        mediaType = detectMediaType(prefix.subarray(0, prefixLength));
        if (mediaType) {
          assertKindMatches(kind, mediaType);
          storageContentType = validateMediaContentType(
            mediaType,
            declaredContentType
          );
          assertByteLimit(totalBytes, mediaType);
          if (contentLength !== null) assertByteLimit(contentLength, mediaType);
        } else if (prefixLength === prefix.byteLength) {
          throw unsupportedMediaError();
        }
      }

      await partBuffer.append(chunk, uploadPart);
    }

    mediaType ||= detectMediaType(prefix.subarray(0, prefixLength));
    if (!mediaType) throw unsupportedMediaError();
    assertKindMatches(kind, mediaType);
    storageContentType ||= validateMediaContentType(
      mediaType,
      declaredContentType
    );
    assertByteLimit(totalBytes, mediaType);
    if (!totalBytes) throw unsupportedMediaError();

    await partBuffer.flush(uploadPart);
    await multipart.complete(uploadedParts);
    multipartCompleted = true;

    const hash = bytesToHex(hasher.digest());
    const key = deriveCanonicalKey(hash, mediaType);
    const canonicalTarget = parseCanonicalMediaUrl(
      `${CANONICAL_R2_ORIGIN}/${key}`,
      env.R2_PUBLIC_BASE_URL
    );
    const existing = await headCanonicalObject(env.MEDIA_BUCKET, canonicalTarget);

    let action;
    if (existing) {
      validateCanonicalHead(canonicalTarget, existing, {
        expectedSize: totalBytes,
      });
      action = "reused";
    } else {
      action = await promoteStagingObject(env.MEDIA_BUCKET, {
        stagingKey,
        canonical: canonicalTarget,
        size: totalBytes,
        contentType: storageContentType,
        uploadId,
        postId,
        sourceUrl: source,
      });
    }

    return buildIngestionResult({
      sourceUrl: source,
      canonical: canonicalTarget,
      size: totalBytes,
      contentType: storageContentType,
      action,
      uploadId,
    });
  } catch (error) {
    primaryError = normalizeIngestionError(error);
    throw primaryError;
  } finally {
    controller.abort();
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // The source stream may already be errored or closed.
      }
    } else {
      try {
        await response.body?.cancel();
      } catch {
        // The source stream may already be errored or closed.
      }
    }

    const cleanupErrors = [];
    if (multipart && !multipartCompleted) {
      try {
        await multipart.abort();
      } catch {
        cleanupErrors.push("multipart-abort");
      }
    }
    if (multipart) {
      try {
        await env.MEDIA_BUCKET.delete(stagingKey);
      } catch {
        cleanupErrors.push("staging-delete");
      }
    }

    if (cleanupErrors.length) {
      throw new MediaIngestionError(
        502,
        "R2 staging cleanup failed.",
        "R2_STAGING_CLEANUP_FAILED",
        {
          operations: cleanupErrors,
          during: primaryError?.details?.code || null,
        }
      );
    }
  }
}

export function validateIngestUrlInput(input) {
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new MediaIngestionError(
      400,
      "Request body must be a JSON object.",
      "INVALID_REQUEST_BODY"
    );
  }

  const allowed = new Set(["sourceUrl", "postId", "kind"]);
  const unexpected = Object.keys(input).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    throw new MediaIngestionError(
      400,
      "Request body contains unsupported fields.",
      "UNSUPPORTED_REQUEST_FIELDS",
      { fields: unexpected.sort() }
    );
  }

  const sourceUrl =
    typeof input.sourceUrl === "string" ? input.sourceUrl.trim() : "";
  if (!sourceUrl || sourceUrl.length > 8192) {
    throw new MediaIngestionError(
      400,
      "sourceUrl must be a non-empty HTTPS URL.",
      "INVALID_SOURCE_URL"
    );
  }

  const kind = input.kind ?? null;
  assertKind(kind);

  return {
    sourceUrl,
    kind,
    postId: input.postId ?? null,
  };
}

export function assertR2Config(env) {
  const requiredMethods = [
    "head",
    "get",
    "put",
    "delete",
    "createMultipartUpload",
  ];
  if (
    !env?.MEDIA_BUCKET ||
    requiredMethods.some(
      (method) => typeof env.MEDIA_BUCKET[method] !== "function"
    )
  ) {
    throw new MediaIngestionError(
      500,
      "MEDIA_BUCKET R2 binding is not configured.",
      "R2_BINDING_MISSING"
    );
  }

  let publicBase;
  try {
    publicBase = new URL(env.R2_PUBLIC_BASE_URL);
  } catch {
    throw new MediaIngestionError(
      500,
      "R2_PUBLIC_BASE_URL is not configured correctly.",
      "R2_PUBLIC_BASE_URL_INVALID"
    );
  }
  if (
    publicBase.origin !== CANONICAL_R2_ORIGIN ||
    publicBase.href !== `${CANONICAL_R2_ORIGIN}/`
  ) {
    throw new MediaIngestionError(
      500,
      "R2_PUBLIC_BASE_URL must be the canonical media origin.",
      "R2_PUBLIC_BASE_URL_INVALID"
    );
  }
}

async function fetchSourceWithRedirects(
  initialUrl,
  fetchImpl,
  publicBaseUrl
) {
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const controller = new AbortController();
    let response;
    try {
      response = await withTimeout(
        fetchImpl(currentUrl.href, {
          method: "GET",
          headers: SOURCE_HEADERS,
          credentials: "omit",
          redirect: "manual",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        }),
        SOURCE_CONNECT_TIMEOUT_MS,
        () => controller.abort(),
        new MediaIngestionError(
          504,
          "Source response timed out.",
          "SOURCE_CONNECT_TIMEOUT"
        )
      );
    } catch (error) {
      controller.abort();
      if (error instanceof MediaIngestionError) throw error;
      throw new MediaIngestionError(
        502,
        "Source request failed.",
        "SOURCE_FETCH_FAILED"
      );
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      if (hop === MAX_REDIRECTS) {
        controller.abort();
        throw new MediaIngestionError(
          502,
          "Source exceeded the redirect limit.",
          "SOURCE_REDIRECT_LIMIT"
        );
      }
      let nextUrl;
      try {
        nextUrl = resolveAndValidateRedirectUrl(
          response.headers.get("Location"),
          currentUrl
        );
      } finally {
        try {
          await response.body?.cancel();
        } catch {
          // Redirect bodies are intentionally discarded.
        }
        controller.abort();
      }
      const canonical = parseCanonicalMediaUrl(nextUrl.href, publicBaseUrl);
      if (canonical) return { canonical };
      currentUrl = nextUrl;
      continue;
    }

    if (!response.ok || response.status === 206) {
      controller.abort();
      throw new MediaIngestionError(
        502,
        "Source returned an unsuccessful response.",
        "SOURCE_HTTP_ERROR",
        { status: response.status }
      );
    }

    return { response, controller };
  }

  throw new MediaIngestionError(
    502,
    "Source exceeded the redirect limit.",
    "SOURCE_REDIRECT_LIMIT"
  );
}

async function readSourceChunk(reader, controller, startedAt) {
  const elapsed = Date.now() - startedAt;
  const remaining = SOURCE_OVERALL_TIMEOUT_MS - elapsed;
  if (remaining <= 0) {
    controller.abort();
    throw new MediaIngestionError(
      504,
      "Source streaming exceeded the overall timeout.",
      "SOURCE_OVERALL_TIMEOUT"
    );
  }

  const timeout = Math.min(SOURCE_INACTIVITY_TIMEOUT_MS, remaining);
  return withTimeout(
    reader.read(),
    timeout,
    () => controller.abort(),
    new MediaIngestionError(
      504,
      "Source streaming stalled.",
      "SOURCE_INACTIVITY_TIMEOUT"
    )
  );
}

async function createMultipartUpload(bucket, stagingKey) {
  try {
    return await bucket.createMultipartUpload(stagingKey);
  } catch {
    throw new MediaIngestionError(
      502,
      "Could not create the R2 staging upload.",
      "R2_MULTIPART_CREATE_FAILED"
    );
  }
}

async function promoteStagingObject(
  bucket,
  { stagingKey, canonical, size, contentType, uploadId, postId, sourceUrl }
) {
  let staged;
  try {
    staged = await bucket.get(stagingKey);
  } catch {
    throw new MediaIngestionError(
      502,
      "Could not read the completed R2 staging object.",
      "R2_STAGING_READ_FAILED"
    );
  }
  if (!staged?.body || staged.size !== size) {
    throw new MediaIngestionError(
      502,
      "Completed R2 staging object failed verification.",
      "R2_STAGING_VERIFY_FAILED"
    );
  }

  const customMetadata = {
    sha256: canonical.sha256,
    "upload-id": uploadId,
  };
  if (postId) customMetadata["source-post-id"] = postId;
  const safeSourceUrl = safeSourceUrlMetadata(sourceUrl);
  if (safeSourceUrl) customMetadata["source-url"] = safeSourceUrl;

  try {
    const stored = await bucket.put(canonical.key, staged.body, {
      httpMetadata: {
        contentType,
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata,
    });
    if (!stored) throw new Error("R2 put returned no object");
  } catch {
    const racedObject = await headCanonicalObject(bucket, canonical);
    if (racedObject) {
      validateCanonicalHead(canonical, racedObject, { expectedSize: size });
      return "reused";
    }
    throw new MediaIngestionError(
      502,
      "Could not promote the staged media object in R2.",
      "R2_CANONICAL_PUT_FAILED"
    );
  }

  const promoted = await headCanonicalObject(bucket, canonical);
  if (!promoted) {
    throw new MediaIngestionError(
      502,
      "Canonical R2 object was absent after upload.",
      "R2_CANONICAL_VERIFY_FAILED"
    );
  }
  validateCanonicalHead(canonical, promoted, { expectedSize: size });
  return "uploaded";
}

async function headCanonicalObject(bucket, canonical) {
  try {
    return await bucket.head(canonical.key);
  } catch {
    throw new MediaIngestionError(
      502,
      "Could not validate the canonical R2 object.",
      "R2_HEAD_FAILED"
    );
  }
}

function validateCanonicalHead(canonical, object, options = {}) {
  const size = Number(object.size);
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new MediaIngestionError(
      409,
      "Canonical R2 object has invalid size metadata.",
      "R2_CANONICAL_SIZE_INVALID"
    );
  }
  assertByteLimit(size, canonical.mediaType);
  if (options.expectedSize !== undefined && size !== options.expectedSize) {
    throw new MediaIngestionError(
      409,
      "Canonical R2 object conflicts with the staged media size.",
      "R2_CANONICAL_SIZE_CONFLICT"
    );
  }

  const storedContentType = object.httpMetadata?.contentType || "";
  if (!mediaTypeFromContentType(storedContentType)) {
    throw new MediaIngestionError(
      409,
      "Canonical R2 object is missing a supported Content-Type.",
      "R2_CANONICAL_CONTENT_TYPE_INVALID"
    );
  }
  const contentType = validateMediaContentType(
    canonical.mediaType,
    storedContentType
  );
  const storedHash = object.customMetadata?.sha256;
  if (storedHash && storedHash !== canonical.sha256) {
    throw new MediaIngestionError(
      409,
      "Canonical R2 object has conflicting hash metadata.",
      "R2_CANONICAL_HASH_CONFLICT"
    );
  }

  return { size, contentType };
}

function buildIngestionResult({
  sourceUrl,
  canonical,
  size,
  contentType,
  action,
  uploadId = null,
}) {
  return {
    sourceUrl,
    url: canonical.url,
    cloudflarePath: canonical.cloudflarePath,
    key: canonical.key,
    filename: canonical.filename,
    sha256: canonical.sha256,
    size,
    contentType,
    mediaKind: canonical.mediaType.kind,
    extension: canonical.mediaType.extension,
    format: canonical.mediaType.notionFormat,
    r2Action: action,
    r2Reused: action === "reused",
    r2Uploaded: action === "uploaded",
    uploadId,
  };
}

function precheckContentLength(contentLength, kind, declaredMediaType) {
  if (contentLength === null) return;
  const mediaType = declaredMediaType || (kind ? { kind } : null);
  const limit = mediaType
    ? byteLimitForMediaType(mediaType)
    : VIDEO_MAX_BYTES;
  if (contentLength > limit) throw tooLargeError(mediaType?.kind);
}

function provisionalByteLimit(kind, mediaType, declaredMediaType) {
  if (mediaType) return byteLimitForMediaType(mediaType);
  if (kind === "image" || declaredMediaType?.kind === "image") {
    return IMAGE_MAX_BYTES;
  }
  return VIDEO_MAX_BYTES;
}

function parseContentLength(value) {
  if (value === null || value === "") return null;
  if (!/^\d+$/.test(value)) return null;
  const size = Number(value);
  return Number.isSafeInteger(size) ? size : null;
}

function assertKind(kind) {
  if (
    kind !== null &&
    kind !== undefined &&
    !["image", "video"].includes(kind)
  ) {
    throw new MediaIngestionError(
      400,
      'kind must be either "image" or "video".',
      "INVALID_MEDIA_KIND"
    );
  }
}

function assertKindMatches(kind, mediaType) {
  if (kind && mediaType && kind !== mediaType.kind) {
    throw new MediaIngestionError(
      415,
      "Detected media type does not match the requested kind.",
      "MEDIA_KIND_MISMATCH"
    );
  }
}

function unsupportedMediaError() {
  return new MediaIngestionError(
    415,
    "Source bytes are not a supported image or video type.",
    "UNSUPPORTED_MEDIA_SIGNATURE"
  );
}

function tooLargeError(kind) {
  const image = kind === "image";
  const limit = image ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
  return new MediaIngestionError(
    413,
    `${image ? "Image" : "Video"} exceeds the ${
      limit / (1024 * 1024)
    } MiB ingestion limit.`,
    "SOURCE_TOO_LARGE",
    { limitBytes: limit }
  );
}

function hasCanonicalOrigin(value) {
  try {
    return new URL(value).origin === CANONICAL_R2_ORIGIN;
  } catch {
    return false;
  }
}

function bytesToHex(bytes) {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

function normalizeIngestionError(error) {
  if (error instanceof MediaIngestionError) return error;
  return new MediaIngestionError(
    502,
    "Media ingestion failed.",
    "MEDIA_INGESTION_FAILED"
  );
}

async function withTimeout(promise, timeoutMs, onTimeout, timeoutError) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(timeoutError);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class MultipartPartBuffer {
  constructor(partSize) {
    this.partSize = partSize;
    this.chunks = [];
    this.size = 0;
  }

  async append(chunk, emit) {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const length = Math.min(
        this.partSize - this.size,
        chunk.byteLength - offset
      );
      this.chunks.push(chunk.subarray(offset, offset + length));
      this.size += length;
      offset += length;

      if (this.size === this.partSize) {
        await emit(concatenateBytes(this.chunks, this.size));
        this.chunks = [];
        this.size = 0;
      }
    }
  }

  async flush(emit) {
    if (!this.size) return;
    await emit(concatenateBytes(this.chunks, this.size));
    this.chunks = [];
    this.size = 0;
  }
}

function concatenateBytes(chunks, size) {
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export const INGESTION_LIMITS = Object.freeze({
  imageBytes: IMAGE_MAX_BYTES,
  videoBytes: VIDEO_MAX_BYTES,
  multipartPartBytes: MULTIPART_PART_BYTES,
  maxRedirects: MAX_REDIRECTS,
  connectTimeoutMs: SOURCE_CONNECT_TIMEOUT_MS,
  inactivityTimeoutMs: SOURCE_INACTIVITY_TIMEOUT_MS,
  overallTimeoutMs: SOURCE_OVERALL_TIMEOUT_MS,
});
