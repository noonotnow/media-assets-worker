import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { CANONICAL_R2_ORIGIN, IMAGE_MAX_BYTES } from "../src/media-ingestion.js";
import {
  ingestSourceToR2,
  stagingPrefixForSource,
} from "../src/r2-ingestion.js";
import { MemoryR2Bucket } from "./helpers/memory-r2.js";

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
]);

test("streams a small image through multipart staging and cleans staging", async () => {
  const bucket = new MemoryR2Bucket();
  const env = testEnv(bucket);
  const sourceUrl = "https://assets.example.com/image";
  let requestInit;

  const result = await ingestSourceToR2(
    env,
    { sourceUrl, postId: "3068d902-271f-810e-82e8-f878238d58dd" },
    {
      fetchImpl: async (url, init) => {
        assert.equal(url, sourceUrl);
        requestInit = init;
        return sourceResponse(PNG_BYTES, "image/png");
      },
    }
  );

  const hash = createHash("sha256").update(PNG_BYTES).digest("hex");
  const key = `images/sha256/${hash.slice(0, 2)}/${hash.slice(
    2,
    4
  )}/${hash}.png`;
  assert.equal(result.url, `${CANONICAL_R2_ORIGIN}/${key}`);
  assert.equal(result.cloudflarePath, `/${key}`);
  assert.equal(result.r2Action, "uploaded");
  assert.equal(result.format, "PNG");
  assert.equal(requestInit.redirect, "manual");
  assert.equal(requestInit.referrerPolicy, "no-referrer");
  assert.equal(requestInit.headers.Authorization, undefined);
  assert.equal(requestInit.headers.Cookie, undefined);

  const stored = await bucket.head(key);
  assert.equal(stored.size, PNG_BYTES.byteLength);
  assert.equal(stored.httpMetadata.contentType, "image/png");
  assert.equal(
    stored.httpMetadata.cacheControl,
    "public, max-age=31536000, immutable"
  );
  assert.equal(stored.customMetadata.sha256, hash);
  assert.equal(
    stored.customMetadata["source-post-id"],
    "3068d902-271f-810e-82e8-f878238d58dd"
  );
  assert.equal(stored.customMetadata["source-url"], sourceUrl);
  assert.deepEqual(bucket.stagingKeys(), []);
  assert.equal(bucket.multipartUploads[0].completed, true);
  assert.equal(bucket.multipartUploads[0].aborted, false);
});

test("reuses an existing canonical URL only with matching SHA metadata", async () => {
  const bucket = new MemoryR2Bucket();
  const hash = createHash("sha256").update(PNG_BYTES).digest("hex");
  const key = `images/sha256/${hash.slice(0, 2)}/${hash.slice(
    2,
    4
  )}/${hash}.png`;
  bucket.seed(key, PNG_BYTES, {
    httpMetadata: { contentType: "image/png" },
    customMetadata: { sha256: hash },
  });

  const result = await ingestSourceToR2(
    testEnv(bucket),
    { sourceUrl: `${CANONICAL_R2_ORIGIN}/${key}` },
    {
      fetchImpl: async () => {
        throw new Error("canonical reuse must not fetch");
      },
    }
  );

  assert.equal(result.r2Action, "reused");
  assert.equal(result.size, PNG_BYTES.byteLength);
  assert.equal(bucket.multipartUploads.length, 0);
  assert.deepEqual(bucket.putKeys, []);
});

test("rejects canonical URLs with missing or mismatched SHA metadata", async () => {
  const hash = createHash("sha256").update(PNG_BYTES).digest("hex");
  const key = `images/sha256/${hash.slice(0, 2)}/${hash.slice(
    2,
    4
  )}/${hash}.png`;

  for (const [label, customMetadata, expectedCode] of [
    ["missing", {}, "R2_CANONICAL_HASH_MISSING"],
    [
      "mismatched",
      { sha256: "ab".repeat(32) },
      "R2_CANONICAL_HASH_CONFLICT",
    ],
  ]) {
    const bucket = new MemoryR2Bucket();
    bucket.seed(key, PNG_BYTES, {
      httpMetadata: { contentType: "image/png" },
      customMetadata,
    });
    await assert.rejects(
      ingestSourceToR2(testEnv(bucket), {
        sourceUrl: `${CANONICAL_R2_ORIGIN}/${key}`,
      }),
      (error) =>
        error.status === 409 &&
        error.details.code === expectedCode,
      label
    );
  }
});

test("preserves staging when an existing canonical object lacks exact SHA metadata", async () => {
  const hash = createHash("sha256").update(PNG_BYTES).digest("hex");
  const key = `images/sha256/${hash.slice(0, 2)}/${hash.slice(
    2,
    4
  )}/${hash}.png`;

  for (const [label, customMetadata, expectedDuring] of [
    ["missing", {}, "R2_CANONICAL_HASH_MISSING"],
    [
      "mismatched",
      { sha256: "cd".repeat(32) },
      "R2_CANONICAL_HASH_CONFLICT",
    ],
  ]) {
    const bucket = new MemoryR2Bucket();
    bucket.seed(key, PNG_BYTES, {
      httpMetadata: { contentType: "image/png" },
      customMetadata,
    });

    await assert.rejects(
      ingestSourceToR2(
        testEnv(bucket),
        { sourceUrl: `https://assets.example.com/${label}-hash.png` },
        { fetchImpl: async () => sourceResponse(PNG_BYTES, "image/png") }
      ),
      (error) =>
        error.status === 409 &&
        error.details.code === "R2_CANONICAL_VERIFY_CONFLICT" &&
        error.details.during === expectedDuring &&
        error.details.stagingKey.startsWith("imports/staging/src-")
    );
    assert.equal(bucket.stagingKeys().length, 1);
  }
});

test("handles a redirect to canonical media with R2 HEAD instead of download", async () => {
  const bucket = new MemoryR2Bucket();
  const hash = createHash("sha256").update(PNG_BYTES).digest("hex");
  const key = `images/sha256/${hash.slice(0, 2)}/${hash.slice(
    2,
    4
  )}/${hash}.png`;
  bucket.seed(key, PNG_BYTES, {
    httpMetadata: { contentType: "image/png" },
    customMetadata: { sha256: hash },
  });
  let fetches = 0;

  const result = await ingestSourceToR2(
    testEnv(bucket),
    { sourceUrl: "https://assets.example.com/canonical-redirect" },
    {
      fetchImpl: async () => {
        fetches += 1;
        return new Response(null, {
          status: 302,
          headers: { Location: `${CANONICAL_R2_ORIGIN}/${key}` },
        });
      },
    }
  );

  assert.equal(fetches, 1);
  assert.equal(result.r2Action, "reused");
  assert.equal(result.url, `${CANONICAL_R2_ORIGIN}/${key}`);
  assert.equal(bucket.multipartUploads.length, 0);
});

test("rejects canonical-looking URLs when the R2 object is absent", async () => {
  const hash = "ab".repeat(32);
  const key = `images/sha256/ab/ab/${hash}.jpg`;
  await assert.rejects(
    ingestSourceToR2(testEnv(new MemoryR2Bucket()), {
      sourceUrl: `${CANONICAL_R2_ORIGIN}/${key}`,
    }),
    (error) => error.status === 404 && error.details.code === "CANONICAL_OBJECT_MISSING"
  );
});

test("rejects canonical objects without compatible stored MIME metadata", async () => {
  const bucket = new MemoryR2Bucket();
  const hash = createHash("sha256").update(PNG_BYTES).digest("hex");
  const key = `images/sha256/${hash.slice(0, 2)}/${hash.slice(
    2,
    4
  )}/${hash}.png`;
  bucket.seed(key, PNG_BYTES, {
    customMetadata: { sha256: hash },
  });

  await assert.rejects(
    ingestSourceToR2(testEnv(bucket), {
      sourceUrl: `${CANONICAL_R2_ORIGIN}/${key}`,
    }),
    (error) =>
      error.status === 409 &&
      error.details.code === "R2_CANONICAL_CONTENT_TYPE_INVALID"
  );
});

test("follows validated redirects without forwarding caller headers", async () => {
  const bucket = new MemoryR2Bucket();
  const calls = [];
  const result = await ingestSourceToR2(
    testEnv(bucket),
    { sourceUrl: "https://source.example.com/start" },
    {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        if (calls.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { Location: "https://cdn.example.com/final.png" },
          });
        }
        return sourceResponse(PNG_BYTES, "application/octet-stream");
      },
    }
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://cdn.example.com/final.png");
  assert.equal(calls[1].init.headers.Authorization, undefined);
  assert.equal(calls[1].init.headers.Referer, undefined);
  assert.equal(result.contentType, "image/png");
});

test("treats a compatible canonical object from a concurrent writer as reused", async () => {
  const bucket = new MemoryR2Bucket();
  const hash = createHash("sha256").update(PNG_BYTES).digest("hex");
  const key = `images/sha256/${hash.slice(0, 2)}/${hash.slice(
    2,
    4
  )}/${hash}.png`;
  const createMultipartUpload = bucket.createMultipartUpload.bind(bucket);
  bucket.createMultipartUpload = async (uploadKey, options) => {
    const upload = await createMultipartUpload(uploadKey, options);
    if (uploadKey !== key) return upload;
    return {
      ...upload,
      async uploadPart() {
        bucket.seed(key, PNG_BYTES, {
          httpMetadata: { contentType: "image/png" },
          customMetadata: { sha256: hash },
        });
        throw new Error("mock concurrent write collision");
      },
    };
  };

  const result = await ingestSourceToR2(
    testEnv(bucket),
    { sourceUrl: "https://assets.example.com/race.png" },
    { fetchImpl: async () => sourceResponse(PNG_BYTES, "image/png") }
  );

  assert.equal(result.r2Action, "reused");
  assert.deepEqual(bucket.stagingKeys(), []);
});

test("preserves completed staging after promotion failure and resumes without source fetch", async () => {
  const bucket = new MemoryR2Bucket();
  const hash = createHash("sha256").update(PNG_BYTES).digest("hex");
  const key = `images/sha256/${hash.slice(0, 2)}/${hash.slice(
    2,
    4
  )}/${hash}.png`;
  bucket.failMultipartForKey = key;
  bucket.failUploadPartAt = 1;

  await assert.rejects(
    ingestSourceToR2(
      testEnv(bucket),
      { sourceUrl: "https://assets.example.com/retry.png" },
      { fetchImpl: async () => sourceResponse(PNG_BYTES, "image/png") }
    ),
    (error) =>
      error.status === 503 &&
      error.details.code === "R2_CANONICAL_PROMOTION_RETRYABLE" &&
      error.details.retryable === true &&
      error.details.stagingKey.startsWith("imports/staging/src-")
  );

  assert.equal(bucket.stagingKeys().length, 1);
  assert.equal(bucket.multipartUploads[0].completed, true);
  assert.equal(bucket.multipartUploads[1].aborted, true);

  bucket.failMultipartForKey = null;
  bucket.failUploadPartAt = null;
  const result = await ingestSourceToR2(
    testEnv(bucket),
    { sourceUrl: "https://assets.example.com/retry.png" },
    {
      fetchImpl: async () => {
        throw new Error("retry must use preserved R2 staging");
      },
    }
  );

  assert.equal(result.r2Action, "uploaded");
  assert.equal(result.stagingResumed, true);
  assert.deepEqual(bucket.stagingKeys(), []);
  assert.equal((await bucket.head(key)).size, PNG_BYTES.byteLength);
});

test("successful retry deletes only the staging object it verified", async () => {
  const bucket = new MemoryR2Bucket();
  const sourceUrl = "https://assets.example.com/concurrent-retries.png";
  const prefix = stagingPrefixForSource(sourceUrl);
  bucket.seed(`${prefix}attempt-a`, PNG_BYTES, {
    httpMetadata: { contentType: "image/png" },
    customMetadata: { "upload-id": "attempt-a" },
  });
  bucket.seed(`${prefix}attempt-b`, PNG_BYTES, {
    httpMetadata: { contentType: "image/png" },
    customMetadata: { "upload-id": "attempt-b" },
  });

  const first = await ingestSourceToR2(
    testEnv(bucket),
    { sourceUrl },
    {
      fetchImpl: async () => {
        throw new Error("preserved staging should avoid source fetch");
      },
    }
  );
  assert.equal(first.stagingResumed, true);
  assert.deepEqual(bucket.stagingKeys(), [`${prefix}attempt-b`]);

  const second = await ingestSourceToR2(
    testEnv(bucket),
    { sourceUrl },
    {
      fetchImpl: async () => {
        throw new Error("second preserved staging should avoid source fetch");
      },
    }
  );
  assert.equal(second.r2Action, "reused");
  assert.deepEqual(bucket.stagingKeys(), []);
});

test("post-copy HEAD failure is retryable and preserves completed staging", async () => {
  const bucket = new MemoryR2Bucket();
  const hash = createHash("sha256").update(PNG_BYTES).digest("hex");
  const key = `images/sha256/${hash.slice(0, 2)}/${hash.slice(
    2,
    4
  )}/${hash}.png`;
  const head = bucket.head.bind(bucket);
  let canonicalHeads = 0;
  bucket.head = async (requestedKey) => {
    if (requestedKey === key) {
      canonicalHeads += 1;
      if (canonicalHeads >= 2) throw new Error("mock transient HEAD failure");
    }
    return head(requestedKey);
  };

  await assert.rejects(
    ingestSourceToR2(
      testEnv(bucket),
      { sourceUrl: "https://assets.example.com/head-retry.png" },
      { fetchImpl: async () => sourceResponse(PNG_BYTES, "image/png") }
    ),
    (error) =>
      error.status === 503 &&
      error.details.code === "R2_CANONICAL_PROMOTION_RETRYABLE" &&
      error.details.retryable === true &&
      error.details.stagingKey.startsWith("imports/staging/src-")
  );
  assert.equal(bucket.stagingKeys().length, 1);
});

test("source multipart writes cannot outlive the staging phase deadline", async () => {
  const bucket = new MemoryR2Bucket();
  const createMultipartUpload = bucket.createMultipartUpload.bind(bucket);
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  bucket.createMultipartUpload = async (key, options) => {
    const upload = await createMultipartUpload(key, options);
    if (!key.startsWith("imports/staging/")) return upload;
    const uploadPart = upload.uploadPart.bind(upload);
    upload.uploadPart = (...args) => {
      now += 30 * 60 * 1000 + 1;
      return uploadPart(...args);
    };
    return upload;
  };

  try {
    await assert.rejects(
      ingestSourceToR2(
        testEnv(bucket),
        { sourceUrl: "https://assets.example.com/slow-staging.png" },
        { fetchImpl: async () => sourceResponse(PNG_BYTES, "image/png") }
      ),
      (error) =>
        error.status === 504 &&
        error.details.code === "SOURCE_OVERALL_TIMEOUT"
    );
    assert.equal(bucket.multipartUploads[0].aborted, true);
    assert.deepEqual(bucket.stagingKeys(), []);
  } finally {
    Date.now = originalNow;
  }
});

test("canonical multipart writes cannot outlive the promotion phase deadline", async () => {
  const bucket = new MemoryR2Bucket();
  const hash = createHash("sha256").update(PNG_BYTES).digest("hex");
  const key = `images/sha256/${hash.slice(0, 2)}/${hash.slice(
    2,
    4
  )}/${hash}.png`;
  const createMultipartUpload = bucket.createMultipartUpload.bind(bucket);
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  bucket.createMultipartUpload = async (uploadKey, options) => {
    const upload = await createMultipartUpload(uploadKey, options);
    if (uploadKey !== key) return upload;
    const uploadPart = upload.uploadPart.bind(upload);
    upload.uploadPart = (...args) => {
      now += 30 * 60 * 1000 + 1;
      return uploadPart(...args);
    };
    return upload;
  };

  try {
    await assert.rejects(
      ingestSourceToR2(
        testEnv(bucket),
        { sourceUrl: "https://assets.example.com/slow-promotion.png" },
        { fetchImpl: async () => sourceResponse(PNG_BYTES, "image/png") }
      ),
      (error) =>
        error.status === 503 &&
        error.details.code === "R2_CANONICAL_PROMOTION_RETRYABLE" &&
        error.details.during === "R2_CANONICAL_PROMOTION_TIMEOUT"
    );
    assert.equal(bucket.multipartUploads[1].aborted, true);
    assert.equal(bucket.stagingKeys().length, 1);
  } finally {
    Date.now = originalNow;
  }
});

test("prechecks oversized image Content-Length before staging", async () => {
  const bucket = new MemoryR2Bucket();
  let cancelled = false;
  await assert.rejects(
    ingestSourceToR2(
      testEnv(bucket),
      {
        sourceUrl: "https://assets.example.com/oversized.png",
        kind: "image",
      },
      {
        fetchImpl: async () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "image/png",
                "Content-Length": String(IMAGE_MAX_BYTES + 1),
              },
            }
          ),
      }
    ),
    (error) => error.status === 413 && error.details.code === "SOURCE_TOO_LARGE"
  );
  assert.equal(bucket.multipartUploads.length, 0);
  assert.equal(cancelled, true);
});

test("rejects HTML bodies and aborts multipart staging", async () => {
  const bucket = new MemoryR2Bucket();
  await assert.rejects(
    ingestSourceToR2(
      testEnv(bucket),
      { sourceUrl: "https://assets.example.com/error" },
      {
        fetchImpl: async () =>
          sourceResponse(
            new TextEncoder().encode("<html><body>error</body></html>"),
            "text/html"
          ),
      }
    ),
    (error) =>
      error.status === 415 &&
      error.details.code === "UNSUPPORTED_MEDIA_SIGNATURE"
  );
  assert.equal(bucket.multipartUploads[0].aborted, true);
  assert.deepEqual(bucket.stagingKeys(), []);
});

test("aborts multipart upload and removes staging after stream failure", async () => {
  const bucket = new MemoryR2Bucket();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(PNG_BYTES);
      controller.error(new Error("mock source failure"));
    },
  });

  await assert.rejects(
    ingestSourceToR2(
      testEnv(bucket),
      { sourceUrl: "https://assets.example.com/broken.png" },
      {
        fetchImpl: async () =>
          new Response(stream, {
            status: 200,
            headers: { "Content-Type": "image/png" },
          }),
      }
    ),
    (error) =>
      error.status === 502 &&
      error.details.code === "MEDIA_INGESTION_FAILED"
  );
  assert.equal(bucket.multipartUploads[0].aborted, true);
  assert.deepEqual(bucket.stagingKeys(), []);
});

function testEnv(bucket) {
  return {
    MEDIA_BUCKET: bucket,
    R2_PUBLIC_BASE_URL: CANONICAL_R2_ORIGIN,
  };
}

function sourceResponse(bytes, contentType, contentLength = bytes.byteLength) {
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(contentLength),
    },
  });
}
