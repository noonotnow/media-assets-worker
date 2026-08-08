import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL_R2_ORIGIN,
  IMAGE_MAX_BYTES,
  VIDEO_MAX_BYTES,
  MediaIngestionError,
  assertByteLimit,
  collapseCanonicalAssets,
  deriveCanonicalKey,
  detectMediaType,
  parseCanonicalMediaUrl,
  resolveAndValidateRedirectUrl,
  validateMediaContentType,
  validatePublicHttpsUrl,
} from "../src/media-ingestion.js";

test("accepts public HTTPS sources and rejects unsafe URL forms", () => {
  assert.equal(
    validatePublicHttpsUrl("https://assets.example.com:443/photo.jpg").href,
    "https://assets.example.com/photo.jpg"
  );
  assert.equal(
    validatePublicHttpsUrl("https://8.8.8.8/media").hostname,
    "8.8.8.8"
  );
  assert.equal(
    validatePublicHttpsUrl(
      "https://[2607:f8b0:4005:805::200e]/media"
    ).protocol,
    "https:"
  );

  const rejected = [
    "http://assets.example.com/photo.jpg",
    "https://user:pass@assets.example.com/photo.jpg",
    "https://assets.example.com:8443/photo.jpg",
    "https://assets.example.com/photo.jpg#fragment",
    "https://localhost/photo.jpg",
    "https://api.local/photo.jpg",
    "https://evil.localhost/photo.jpg",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://127.0.0.1/photo.jpg",
    "https://127.1/photo.jpg",
    "https://10.0.0.1/photo.jpg",
    "https://169.254.169.254/latest/meta-data/",
    "https://192.168.1.1/photo.jpg",
    "https://224.0.0.1/photo.jpg",
    "https://[::]/photo.jpg",
    "https://[::1]/photo.jpg",
    "https://[fc00::1]/photo.jpg",
    "https://[fe80::1]/photo.jpg",
    "https://[ff02::1]/photo.jpg",
    "https://[::ffff:127.0.0.1]/photo.jpg",
  ];

  for (const value of rejected) {
    assert.throws(
      () => validatePublicHttpsUrl(value),
      (error) => error instanceof MediaIngestionError,
      value
    );
  }
});

test("revalidates relative and absolute redirects", () => {
  const current = new URL("https://assets.example.com/path/start");
  assert.equal(
    resolveAndValidateRedirectUrl("../final.png", current).href,
    "https://assets.example.com/final.png"
  );
  assert.throws(
    () => resolveAndValidateRedirectUrl("https://127.0.0.1/private", current),
    (error) => error.details.code === "UNSAFE_SOURCE_REDIRECT"
  );
  assert.throws(
    () => resolveAndValidateRedirectUrl("http://example.com/plain", current),
    (error) => error.details.code === "UNSAFE_SOURCE_REDIRECT"
  );
  assert.throws(
    () =>
      resolveAndValidateRedirectUrl(
        `${CANONICAL_R2_ORIGIN}/videos/staging/unfinished`,
        current
      ),
    (error) =>
      error.details.code === "UNSAFE_SOURCE_REDIRECT" &&
      error.details.reason === "INVALID_CANONICAL_URL"
  );
});

test("parses only exact canonical media URLs and validates shard paths", () => {
  const hash = "ab".repeat(32);
  const key = `images/sha256/ab/ab/${hash}.jpg`;
  assert.deepEqual(
    parseCanonicalMediaUrl(`${CANONICAL_R2_ORIGIN}/${key}`),
    {
      url: `${CANONICAL_R2_ORIGIN}/${key}`,
      key,
      cloudflarePath: `/${key}`,
      filename: `${hash}.jpg`,
      sha256: hash,
      mediaType: detectMediaType(Uint8Array.from([0xff, 0xd8, 0xff])),
    }
  );
  assert.equal(
    parseCanonicalMediaUrl(`${CANONICAL_R2_ORIGIN}/${key}?download=1`),
    null
  );
  assert.equal(
    parseCanonicalMediaUrl(
      `${CANONICAL_R2_ORIGIN}/images/sha256/00/ab/${hash}.jpg`
    ),
    null
  );
  assert.equal(
    parseCanonicalMediaUrl(
      `${CANONICAL_R2_ORIGIN}/videos/sha256/ab/ab/${hash}.jpg`
    ),
    null
  );
  assert.equal(
    parseCanonicalMediaUrl(`https://example.com/${key}`),
    null
  );
});

test("detects supported media signatures and enforces MIME agreement", () => {
  const samples = [
    [Uint8Array.from([0xff, 0xd8, 0xff, 0xdb]), "jpg", "image/jpeg"],
    [
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      "png",
      "image/png",
    ],
    [
      Uint8Array.from([
        0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
      ]),
      "webp",
      "image/webp",
    ],
    [new TextEncoder().encode("GIF89a"), "gif", "image/gif"],
    [isoBaseMedia("isom"), "mp4", "video/mp4"],
    [isoBaseMedia("qt  "), "mov", "video/quicktime"],
    [
      Uint8Array.from([
        0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d,
      ]),
      "webm",
      "video/webm",
    ],
  ];

  for (const [bytes, extension, mime] of samples) {
    const mediaType = detectMediaType(bytes);
    assert.equal(mediaType.extension, extension);
    assert.equal(validateMediaContentType(mediaType, mime), mime);
    assert.equal(
      validateMediaContentType(mediaType, "application/octet-stream"),
      mediaType.mime
    );
  }

  const jpeg = detectMediaType(Uint8Array.from([0xff, 0xd8, 0xff]));
  assert.equal(validateMediaContentType(jpeg, "image/jpg"), "image/jpg");
  assert.throws(
    () => validateMediaContentType(jpeg, "text/html"),
    (error) => error.details.code === "MEDIA_TYPE_MISMATCH"
  );
  assert.throws(
    () => validateMediaContentType(jpeg, "image/png"),
    (error) => error.details.code === "MEDIA_TYPE_MISMATCH"
  );
  assert.equal(detectMediaType(new TextEncoder().encode("<html>error")), null);
});

test("derives content-addressed keys and enforces media byte limits", () => {
  const hash = "0123456789abcdef".repeat(4);
  const png = detectMediaType(
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  );
  const mp4 = detectMediaType(isoBaseMedia("mp42"));
  assert.equal(
    deriveCanonicalKey(hash, png),
    `images/sha256/01/23/${hash}.png`
  );
  assert.equal(
    deriveCanonicalKey(hash, mp4),
    `videos/sha256/01/23/${hash}.mp4`
  );
  assert.doesNotThrow(() => assertByteLimit(IMAGE_MAX_BYTES, png));
  assert.doesNotThrow(() => assertByteLimit(VIDEO_MAX_BYTES, mp4));
  assert.throws(
    () => assertByteLimit(IMAGE_MAX_BYTES + 1, png),
    (error) => error.status === 413
  );
  assert.throws(
    () => assertByteLimit(VIDEO_MAX_BYTES + 1, mp4),
    (error) => error.status === 413
  );
});

test("collapses different source URLs with identical canonical content", () => {
  const first = {
    sourceAsset: { url: "https://example.com/a.png", sourceIndex: 1 },
    ingestion: {
      key: "images/sha256/aa/bb/hash.png",
      url: `${CANONICAL_R2_ORIGIN}/images/sha256/aa/bb/hash.png`,
      cloudflarePath: "/images/sha256/aa/bb/hash.png",
    },
  };
  const duplicate = {
    sourceAsset: { url: "https://cdn.example.com/b.png", sourceIndex: 2 },
    ingestion: { ...first.ingestion },
  };

  const result = collapseCanonicalAssets([first, duplicate]);
  assert.deepEqual(result.unique, [first]);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].reason, "duplicate-content");
  assert.equal(result.duplicates[0].duplicateOfSourceUrl, first.sourceAsset.url);
});

function isoBaseMedia(brand) {
  const bytes = new Uint8Array(24);
  bytes.set([0, 0, 0, 24], 0);
  bytes.set(new TextEncoder().encode("ftyp"), 4);
  bytes.set(new TextEncoder().encode(brand), 8);
  bytes.set(new TextEncoder().encode(brand), 16);
  return bytes;
}
