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
const CANONICAL_PART_UPLOAD_ATTEMPTS = 3;
const STAGING_LIST_PAGE_LIMIT = 100;
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
  const stagingPrefix = stagingPrefixForSource(initialUrl.href);
  const preservedStaging = await findPreservedStaging(
    env.MEDIA_BUCKET,
    stagingPrefix
  );
  if (preservedStaging) {
    return resumeStagedPromotion(env, {
      stagingObject: preservedStaging,
      stagingPrefix,
      sourceUrl: source,
      postId,
      kind,
    });
  }

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

    const stagingStartedAt = Date.now();
    uploadId = crypto.randomUUID();
    stagingKey = `${stagingPrefix}${uploadId}`;
    multipart = await withPhaseDeadline(
      createMultipartUpload(env.MEDIA_BUCKET, stagingKey, {
        httpMetadata: {
          contentType: declaredContentType || "application/octet-stream",
        },
        customMetadata: buildStagingMetadata({
          sourceUrl: source,
          sourceFingerprint: sourceFingerprint(initialUrl.href),
          uploadId,
          postId,
        }),
      }),
      stagingStartedAt,
      () => controller.abort(),
      sourceOverallTimeoutError()
    );
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
    let prefixLength = 0;
    let totalBytes = 0;
    let mediaType = null;
    let storageContentType = null;
    let partNumber = 1;

    const uploadPart = async (bytes) => {
      const part = await withPhaseDeadline(
        multipart.uploadPart(partNumber, bytes),
        stagingStartedAt,
        () => controller.abort(),
        sourceOverallTimeoutError()
      );
      uploadedParts.push(part);
      partNumber += 1;
    };

    while (true) {
      const { done, value } = await readSourceChunk(
        reader,
        controller,
        stagingStartedAt
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
    await withPhaseDeadline(
      multipart.complete(uploadedParts),
      stagingStartedAt,
      () => controller.abort(),
      sourceOverallTimeoutError()
    );
    multipartCompleted = true;

    const hash = bytesToHex(hasher.digest());
    const key = deriveCanonicalKey(hash, mediaType);
    const canonicalTarget = parseCanonicalMediaUrl(
      `${CANONICAL_R2_ORIGIN}/${key}`,
      env.R2_PUBLIC_BASE_URL
    );
    const existing = await headCanonicalForPromotion(
      env.MEDIA_BUCKET,
      canonicalTarget,
      stagingKey,
      stagingStartedAt
    );

    let action;
    if (existing) {
      validateCanonicalForPromotion(
        canonicalTarget,
        existing,
        totalBytes,
        stagingKey
      );
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

    await deleteStagingObject(env.MEDIA_BUCKET, stagingKey);
    return buildIngestionResult({
      sourceUrl: source,
      canonical: canonicalTarget,
      size: totalBytes,
      contentType: storageContentType,
      action,
      uploadId,
      stagingResumed: false,
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
    if (multipart && !multipartCompleted) {
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

export function stagingPrefixForSource(sourceUrl) {
  return `imports/staging/src-${sourceFingerprint(sourceUrl)}-`;
}

export function isR2Configured(env) {
  if (!hasR2Binding(env)) {
    return false;
  }

  try {
    const publicBase = new URL(env.R2_PUBLIC_BASE_URL);
    return (
      publicBase.origin === CANONICAL_R2_ORIGIN &&
      publicBase.href === `${CANONICAL_R2_ORIGIN}/`
    );
  } catch {
    return false;
  }
}

export function assertR2Config(env) {
  if (!hasR2Binding(env)) {
    throw new MediaIngestionError(
      500,
      "MEDIA_BUCKET R2 binding is not configured.",
      "R2_BINDING_MISSING"
    );
  }
  if (!isR2Configured(env)) {
    throw new MediaIngestionError(
      500,
      "R2_PUBLIC_BASE_URL must be the canonical media origin.",
      "R2_PUBLIC_BASE_URL_INVALID"
    );
  }
}

function hasR2Binding(env) {
  const requiredMethods = [
    "head",
    "get",
    "delete",
    "list",
    "createMultipartUpload",
  ];
  return Boolean(
    env?.MEDIA_BUCKET &&
      requiredMethods.every(
        (method) => typeof env.MEDIA_BUCKET[method] === "function"
      )
  );
}

async function findPreservedStaging(bucket, stagingPrefix) {
  let listed;
  try {
    listed = await bucket.list({
      prefix: stagingPrefix,
      limit: STAGING_LIST_PAGE_LIMIT,
      include: ["httpMetadata", "customMetadata"],
    });
  } catch {
    throw new MediaIngestionError(
      503,
      "Could not inspect retryable R2 staging.",
      "R2_STAGING_LIST_RETRYABLE",
      { retryable: true }
    );
  }

  return [...(listed.objects || [])].sort((left, right) =>
    left.key.localeCompare(right.key)
  )[0] || null;
}

async function resumeStagedPromotion(
  env,
  { stagingObject, stagingPrefix, sourceUrl, postId, kind }
) {
  const inspected = await inspectStagingObject(
    env.MEDIA_BUCKET,
    stagingObject,
    kind
  );
  const key = deriveCanonicalKey(inspected.sha256, inspected.mediaType);
  const canonical = parseCanonicalMediaUrl(
    `${CANONICAL_R2_ORIGIN}/${key}`,
    env.R2_PUBLIC_BASE_URL
  );
  const existing = await headCanonicalForPromotion(
    env.MEDIA_BUCKET,
    canonical,
    stagingObject.key
  );
  let action;
  if (existing) {
    validateCanonicalForPromotion(
      canonical,
      existing,
      inspected.size,
      stagingObject.key
    );
    action = "reused";
  } else {
    action = await promoteStagingObject(env.MEDIA_BUCKET, {
      stagingKey: stagingObject.key,
      canonical,
      size: inspected.size,
      contentType: inspected.contentType,
      uploadId:
        stagingObject.customMetadata?.["upload-id"] ||
        stagingObject.key.slice(stagingPrefix.length),
      postId,
      sourceUrl,
    });
  }

  await deleteStagingObject(env.MEDIA_BUCKET, stagingObject.key);
  return buildIngestionResult({
    sourceUrl,
    canonical,
    size: inspected.size,
    contentType: inspected.contentType,
    action,
    uploadId: stagingObject.customMetadata?.["upload-id"] || null,
    stagingResumed: true,
  });
}

async function inspectStagingObject(bucket, stagingObject, kind) {
  const startedAt = Date.now();
  const staged = await getStagingObject(
    bucket,
    stagingObject.key,
    stagingObject.size,
    startedAt
  );
  const declaredContentType = staged.httpMetadata?.contentType || "";
  const declaredMediaType = mediaTypeFromContentType(declaredContentType);
  assertKindMatches(kind, declaredMediaType);
  precheckContentLength(staged.size, kind, declaredMediaType);

  const reader = staged.body.getReader();
  const hasher = sha256.create();
  const prefix = new Uint8Array(MEDIA_SNIFF_BYTES);
  let prefixLength = 0;
  let totalBytes = 0;
  let mediaType = null;
  let contentType = null;

  try {
    while (true) {
      const { done, value } = await readInternalChunk(reader, startedAt);
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
          contentType = validateMediaContentType(
            mediaType,
            declaredContentType
          );
          assertByteLimit(staged.size, mediaType);
        } else if (prefixLength === prefix.byteLength) {
          throw unsupportedMediaError();
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The completed staging stream may already be closed.
    }
  }

  mediaType ||= detectMediaType(prefix.subarray(0, prefixLength));
  if (!mediaType || totalBytes !== staged.size) {
    throw new MediaIngestionError(
      503,
      "Completed R2 staging object could not be verified for retry.",
      "R2_STAGING_VERIFY_RETRYABLE",
      { retryable: true, stagingKey: stagingObject.key }
    );
  }
  assertKindMatches(kind, mediaType);
  contentType ||= validateMediaContentType(mediaType, declaredContentType);
  assertByteLimit(totalBytes, mediaType);

  return {
    sha256: bytesToHex(hasher.digest()),
    size: totalBytes,
    mediaType,
    contentType,
  };
}

async function deleteStagingObject(bucket, stagingKey) {
  try {
    await bucket.delete(stagingKey);
  } catch {
    throw new MediaIngestionError(
      503,
      "Canonical media is verified, but retryable staging cleanup failed.",
      "R2_STAGING_CLEANUP_RETRYABLE",
      { retryable: true, stagingKey }
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

async function createMultipartUpload(bucket, stagingKey, options) {
  try {
    return await bucket.createMultipartUpload(stagingKey, options);
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
  const customMetadata = {
    sha256: canonical.sha256,
    "upload-id": uploadId,
  };
  if (postId) customMetadata["source-post-id"] = postId;
  const safeSourceUrl = safeSourceUrlMetadata(sourceUrl);
  if (safeSourceUrl) customMetadata["source-url"] = safeSourceUrl;

  let destinationUpload = null;
  let destinationCompleted = false;
  let reader = null;
  let promotionError = null;
  const promotionStartedAt = Date.now();
  try {
    const staged = await getStagingObject(
      bucket,
      stagingKey,
      size,
      promotionStartedAt
    );
    reader = staged.body.getReader();
    destinationUpload = await withPhaseDeadline(
      bucket.createMultipartUpload(canonical.key, {
        httpMetadata: {
          contentType,
          cacheControl: "public, max-age=31536000, immutable",
        },
        customMetadata,
      }),
      promotionStartedAt,
      () => reader.cancel(),
      promotionOverallTimeoutError(stagingKey)
    );
    const uploadedParts = [];
    const partBuffer = new MultipartPartBuffer(MULTIPART_PART_BYTES);
    let copiedBytes = 0;
    let partNumber = 1;

    const uploadPart = async (bytes) => {
      const part = await uploadCanonicalPartWithRetry(
        destinationUpload,
        partNumber,
        bytes,
        promotionStartedAt,
        stagingKey
      );
      uploadedParts.push(part);
      partNumber += 1;
    };

    while (true) {
      const { done, value } = await readInternalChunk(
        reader,
        promotionStartedAt
      );
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      copiedBytes += chunk.byteLength;
      if (copiedBytes > size) {
        throw new MediaIngestionError(
          502,
          "R2 staging object changed during canonical promotion.",
          "R2_STAGING_SIZE_CHANGED"
        );
      }
      await partBuffer.append(chunk, uploadPart);
    }
    if (copiedBytes !== size) {
      throw new MediaIngestionError(
        502,
        "R2 staging object ended before canonical promotion completed.",
        "R2_STAGING_SIZE_CHANGED"
      );
    }
    await partBuffer.flush(uploadPart);
    await withPhaseDeadline(
      destinationUpload.complete(uploadedParts),
      promotionStartedAt,
      () => reader.cancel(),
      promotionOverallTimeoutError(stagingKey)
    );
    destinationCompleted = true;

    const promoted = await withPhaseDeadline(
      headCanonicalObject(bucket, canonical),
      promotionStartedAt,
      () => undefined,
      promotionOverallTimeoutError(stagingKey)
    );
    if (!promoted) {
      throw new MediaIngestionError(
        503,
        "Canonical R2 object was absent after upload.",
        "R2_CANONICAL_VERIFY_RETRYABLE"
      );
    }
    validateCanonicalForPromotion(canonical, promoted, size, stagingKey);
    return "uploaded";
  } catch (error) {
    promotionError = error;
    let racedObject = null;
    try {
      racedObject = await withPhaseDeadline(
        bucket.head(canonical.key),
        promotionStartedAt,
        () => undefined,
        promotionOverallTimeoutError(stagingKey)
      );
    } catch {
      // A transient HEAD failure is returned as a retryable promotion error.
    }
    if (racedObject) {
      validateCanonicalForPromotion(
        canonical,
        racedObject,
        size,
        stagingKey
      );
      return destinationCompleted ? "uploaded" : "reused";
    }
    throw new MediaIngestionError(
      503,
      "Canonical R2 promotion failed; completed staging was preserved for retry.",
      "R2_CANONICAL_PROMOTION_RETRYABLE",
      {
        retryable: true,
        stagingKey,
        during: error?.details?.code || null,
      }
    );
  } finally {
    try {
      await reader?.cancel();
    } catch {
      // The R2 staging stream may already be closed.
    }
    if (destinationUpload && !destinationCompleted) {
      try {
        await destinationUpload.abort();
      } catch {
        throw new MediaIngestionError(
          503,
          "Canonical R2 promotion failed and destination cleanup could not be confirmed.",
          "R2_CANONICAL_PROMOTION_ABORT_FAILED",
          {
            retryable: true,
            stagingKey,
            during: promotionError?.details?.code || null,
          }
        );
      }
    }
  }
}

async function getStagingObject(
  bucket,
  stagingKey,
  expectedSize,
  phaseStartedAt = Date.now()
) {
  let staged;
  try {
    staged = await withPhaseDeadline(
      bucket.get(stagingKey),
      phaseStartedAt,
      () => undefined,
      stagingOverallTimeoutError(stagingKey)
    );
  } catch (error) {
    if (error instanceof MediaIngestionError) throw error;
    throw new MediaIngestionError(
      503,
      "Could not read the completed R2 staging object.",
      "R2_STAGING_READ_RETRYABLE",
      { retryable: true, stagingKey }
    );
  }
  if (
    !staged?.body ||
    (expectedSize !== undefined && staged.size !== expectedSize)
  ) {
    throw new MediaIngestionError(
      503,
      "Completed R2 staging object failed verification.",
      "R2_STAGING_VERIFY_RETRYABLE",
      { retryable: true, stagingKey }
    );
  }
  return staged;
}

async function uploadCanonicalPartWithRetry(
  upload,
  partNumber,
  bytes,
  phaseStartedAt,
  stagingKey
) {
  let lastError;
  for (
    let attempt = 1;
    attempt <= CANONICAL_PART_UPLOAD_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return await withPhaseDeadline(
        upload.uploadPart(partNumber, bytes),
        phaseStartedAt,
        () => undefined,
        promotionOverallTimeoutError(stagingKey)
      );
    } catch (error) {
      if (error?.details?.code === "R2_CANONICAL_PROMOTION_TIMEOUT") {
        throw error;
      }
      lastError = error;
      if (attempt < CANONICAL_PART_UPLOAD_ATTEMPTS) {
        await delay(25 * attempt);
      }
    }
  }
  throw lastError;
}

async function readInternalChunk(reader, startedAt = Date.now()) {
  const remaining = SOURCE_OVERALL_TIMEOUT_MS - (Date.now() - startedAt);
  if (remaining <= 0) {
    throw new MediaIngestionError(
      503,
      "R2 staging operation exceeded the overall timeout.",
      "R2_STAGING_OVERALL_TIMEOUT"
    );
  }
  return withTimeout(
    reader.read(),
    Math.min(SOURCE_INACTIVITY_TIMEOUT_MS, remaining),
    () => reader.cancel(),
    new MediaIngestionError(
      503,
      "R2 staging copy stalled during canonical promotion.",
      "R2_CANONICAL_COPY_TIMEOUT"
    )
  );
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

async function headCanonicalForPromotion(
  bucket,
  canonical,
  stagingKey,
  phaseStartedAt = Date.now()
) {
  try {
    return await withPhaseDeadline(
      headCanonicalObject(bucket, canonical),
      phaseStartedAt,
      () => undefined,
      promotionOverallTimeoutError(stagingKey)
    );
  } catch (error) {
    throw new MediaIngestionError(
      503,
      "Canonical R2 validation failed; completed staging was preserved for retry.",
      "R2_CANONICAL_PROMOTION_RETRYABLE",
      {
        retryable: true,
        stagingKey,
        during: error?.details?.code || null,
      }
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
  if (!storedHash) {
    throw new MediaIngestionError(
      409,
      "Canonical R2 object is missing required SHA-256 metadata.",
      "R2_CANONICAL_HASH_MISSING"
    );
  }
  if (storedHash !== canonical.sha256) {
    throw new MediaIngestionError(
      409,
      "Canonical R2 object has conflicting hash metadata.",
      "R2_CANONICAL_HASH_CONFLICT"
    );
  }

  return { size, contentType };
}

function validateCanonicalForPromotion(
  canonical,
  object,
  expectedSize,
  stagingKey
) {
  try {
    return validateCanonicalHead(canonical, object, { expectedSize });
  } catch (error) {
    throw new MediaIngestionError(
      409,
      "Canonical R2 metadata conflicts with completed staging; staging was preserved for recovery.",
      "R2_CANONICAL_VERIFY_CONFLICT",
      {
        retryable: false,
        stagingKey,
        recovery: "repair-or-remove-canonical-object",
        during: error?.details?.code || null,
      }
    );
  }
}

function buildIngestionResult({
  sourceUrl,
  canonical,
  size,
  contentType,
  action,
  uploadId = null,
  stagingResumed = false,
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
    stagingResumed,
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

function sourceFingerprint(sourceUrl) {
  return bytesToHex(sha256(new TextEncoder().encode(sourceUrl)));
}

function buildStagingMetadata({
  sourceUrl,
  sourceFingerprint: fingerprint,
  uploadId,
  postId,
}) {
  const metadata = {
    "source-fingerprint": fingerprint,
    "upload-id": uploadId,
  };
  if (postId) metadata["source-post-id"] = postId;
  const safeSourceUrl = safeSourceUrlMetadata(sourceUrl);
  if (safeSourceUrl) metadata["source-url"] = safeSourceUrl;
  return metadata;
}

function normalizeIngestionError(error) {
  if (error instanceof MediaIngestionError) return error;
  return new MediaIngestionError(
    502,
    "Media ingestion failed.",
    "MEDIA_INGESTION_FAILED"
  );
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sourceOverallTimeoutError() {
  return new MediaIngestionError(
    504,
    "Source staging exceeded the overall timeout.",
    "SOURCE_OVERALL_TIMEOUT"
  );
}

function stagingOverallTimeoutError(stagingKey) {
  return new MediaIngestionError(
    503,
    "R2 staging verification exceeded the overall timeout.",
    "R2_STAGING_OVERALL_TIMEOUT",
    { retryable: true, stagingKey }
  );
}

function promotionOverallTimeoutError(stagingKey) {
  return new MediaIngestionError(
    503,
    "Canonical R2 promotion exceeded the overall timeout.",
    "R2_CANONICAL_PROMOTION_TIMEOUT",
    { retryable: true, stagingKey }
  );
}

async function withPhaseDeadline(
  promise,
  startedAt,
  onTimeout,
  timeoutError
) {
  const remaining = SOURCE_OVERALL_TIMEOUT_MS - (Date.now() - startedAt);
  if (remaining <= 0) {
    Promise.resolve(promise).catch(() => undefined);
    runTimeoutAction(onTimeout);
    throw timeoutError;
  }
  return withTimeout(promise, remaining, onTimeout, timeoutError);
}

async function withTimeout(promise, timeoutMs, onTimeout, timeoutError) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          runTimeoutAction(onTimeout);
          reject(timeoutError);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function runTimeoutAction(action) {
  try {
    Promise.resolve(action()).catch(() => undefined);
  } catch {
    // Timeout cleanup is best effort; the primary timeout remains authoritative.
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
