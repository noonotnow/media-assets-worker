export const CANONICAL_R2_ORIGIN = "https://images.xhs.justlikekatie.com";
export const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 1024 * 1024 * 1024;
export const MULTIPART_PART_BYTES = 16 * 1024 * 1024;
export const MEDIA_SNIFF_BYTES = 4096;

const MEDIA_TYPES = Object.freeze({
  jpg: Object.freeze({
    extension: "jpg",
    kind: "image",
    mime: "image/jpeg",
    notionFormat: "JPG",
  }),
  png: Object.freeze({
    extension: "png",
    kind: "image",
    mime: "image/png",
    notionFormat: "PNG",
  }),
  webp: Object.freeze({
    extension: "webp",
    kind: "image",
    mime: "image/webp",
    notionFormat: null,
  }),
  gif: Object.freeze({
    extension: "gif",
    kind: "image",
    mime: "image/gif",
    notionFormat: null,
  }),
  mp4: Object.freeze({
    extension: "mp4",
    kind: "video",
    mime: "video/mp4",
    notionFormat: "MP4",
  }),
  mov: Object.freeze({
    extension: "mov",
    kind: "video",
    mime: "video/quicktime",
    notionFormat: null,
  }),
  webm: Object.freeze({
    extension: "webm",
    kind: "video",
    mime: "video/webm",
    notionFormat: null,
  }),
});

const MIME_TYPES = new Map([
  ["image/jpeg", MEDIA_TYPES.jpg],
  ["image/jpg", MEDIA_TYPES.jpg],
  ["image/pjpeg", MEDIA_TYPES.jpg],
  ["image/png", MEDIA_TYPES.png],
  ["image/webp", MEDIA_TYPES.webp],
  ["image/gif", MEDIA_TYPES.gif],
  ["video/mp4", MEDIA_TYPES.mp4],
  ["video/quicktime", MEDIA_TYPES.mov],
  ["video/webm", MEDIA_TYPES.webm],
]);

const GENERIC_MIME_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
]);

const MP4_BRANDS = new Set([
  "3gp4",
  "3gp5",
  "avc1",
  "dash",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "isom",
  "mmp4",
  "mp41",
  "mp42",
  "msnv",
]);

const BLOCKED_IPV4_CIDRS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
].map(([address, prefix]) => [ipv4ToInteger(address), prefix]);

const BLOCKED_HOSTNAMES = new Set([
  "instance-data",
  "metadata",
  "metadata.google.internal",
]);

const CLOUD_METADATA_IPV4 = new Set([
  "100.100.100.200",
  "168.63.129.16",
  "169.254.169.254",
  "169.254.170.2",
]);

export class MediaIngestionError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.name = "MediaIngestionError";
    this.status = status;
    this.details = {
      ...(code ? { code } : {}),
      ...(details || {}),
    };
  }
}

export function validatePublicHttpsUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw.length > 8192) {
    throw new MediaIngestionError(
      400,
      "sourceUrl must be a non-empty HTTPS URL.",
      "INVALID_SOURCE_URL"
    );
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new MediaIngestionError(
      400,
      "sourceUrl must be a valid HTTPS URL.",
      "INVALID_SOURCE_URL"
    );
  }

  if (url.protocol !== "https:") {
    throw new MediaIngestionError(
      400,
      "Source URLs must use HTTPS.",
      "UNSAFE_SOURCE_PROTOCOL"
    );
  }
  if (url.username || url.password) {
    throw new MediaIngestionError(
      400,
      "Source URLs cannot contain user information.",
      "UNSAFE_SOURCE_USERINFO"
    );
  }
  if (url.hash) {
    throw new MediaIngestionError(
      400,
      "Source URLs cannot contain fragments.",
      "UNSAFE_SOURCE_FRAGMENT"
    );
  }
  if (url.port && url.port !== "443") {
    throw new MediaIngestionError(
      400,
      "Source URLs can only use the default HTTPS port.",
      "UNSAFE_SOURCE_PORT"
    );
  }
  if (isTemporaryNotionHostedUrl(url)) {
    throw new MediaIngestionError(
      400,
      "Temporary Notion-hosted file URLs are not stable media sources.",
      "TEMPORARY_NOTION_SOURCE"
    );
  }
  if (isBlockedSourceHostname(url.hostname)) {
    throw new MediaIngestionError(
      400,
      "Source URL host is not publicly routable.",
      "UNSAFE_SOURCE_HOST"
    );
  }

  return url;
}

export function resolveAndValidateRedirectUrl(location, currentUrl) {
  if (typeof location !== "string" || !location.trim()) {
    throw new MediaIngestionError(
      502,
      "Source redirect did not include a valid Location header.",
      "INVALID_SOURCE_REDIRECT"
    );
  }

  let resolved;
  try {
    resolved = new URL(location, currentUrl);
  } catch {
    throw new MediaIngestionError(
      502,
      "Source redirect Location was invalid.",
      "INVALID_SOURCE_REDIRECT"
    );
  }

  try {
    return validatePublicHttpsUrl(resolved.href);
  } catch (error) {
    if (error instanceof MediaIngestionError) {
      throw new MediaIngestionError(
        502,
        "Source redirect targeted an unsafe URL.",
        "UNSAFE_SOURCE_REDIRECT",
        { reason: error.details?.code }
      );
    }
    throw error;
  }
}

export function isBlockedSourceHostname(value) {
  const hostname = stripIpv6Brackets(String(value || ""))
    .toLowerCase()
    .replace(/\.$/, "");
  if (!hostname) return true;
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "local" ||
    hostname.endsWith(".local") ||
    BLOCKED_HOSTNAMES.has(hostname)
  ) {
    return true;
  }

  const ipv4 = parseIpv4(hostname);
  if (ipv4) return isBlockedIpv4(ipv4);
  if (hostname.includes(":")) return isBlockedIpv6(hostname);
  return false;
}

export function parseCanonicalMediaUrl(
  value,
  publicBaseUrl = CANONICAL_R2_ORIGIN
) {
  let url;
  let base;
  try {
    url = new URL(value);
    base = new URL(publicBaseUrl);
  } catch {
    return null;
  }

  if (
    base.origin !== CANONICAL_R2_ORIGIN ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port && url.port !== "443")
  ) {
    return null;
  }

  const key = url.pathname.slice(1);
  const match = key.match(
    /^(images|videos)\/sha256\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})\.(jpg|png|webp|gif|mp4|mov|webm)$/
  );
  if (!match) return null;

  const [, directory, first, second, sha256, extension] = match;
  const mediaType = MEDIA_TYPES[extension];
  if (
    first !== sha256.slice(0, 2) ||
    second !== sha256.slice(2, 4) ||
    directory !== `${mediaType.kind}s`
  ) {
    return null;
  }

  return {
    url: `${CANONICAL_R2_ORIGIN}/${key}`,
    key,
    cloudflarePath: `/${key}`,
    filename: `${sha256}.${extension}`,
    sha256,
    mediaType,
  };
}

export function deriveCanonicalKey(sha256, mediaType) {
  if (!/^[0-9a-f]{64}$/.test(sha256) || !isKnownMediaType(mediaType)) {
    throw new MediaIngestionError(
      500,
      "Cannot derive a canonical media key.",
      "INVALID_CANONICAL_KEY_INPUT"
    );
  }

  return `${mediaType.kind}s/sha256/${sha256.slice(0, 2)}/${sha256.slice(
    2,
    4
  )}/${sha256}.${mediaType.extension}`;
}

export function detectMediaType(value) {
  const bytes = toBytes(value);
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return MEDIA_TYPES.jpg;
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 3) === "PNG" &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return MEDIA_TYPES.png;
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  ) {
    return MEDIA_TYPES.webp;
  }
  if (
    bytes.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))
  ) {
    return MEDIA_TYPES.gif;
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 4, 4) === "ftyp"
  ) {
    return detectIsoBaseMediaType(bytes);
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3 &&
    ascii(bytes, 0, bytes.length).toLowerCase().includes("webm")
  ) {
    return MEDIA_TYPES.webm;
  }
  return null;
}

export function mediaTypeFromContentType(value) {
  return MIME_TYPES.get(normalizeContentType(value)) || null;
}

export function validateMediaContentType(mediaType, declaredContentType) {
  if (!isKnownMediaType(mediaType)) {
    throw new MediaIngestionError(
      415,
      "Source bytes are not a supported media type.",
      "UNSUPPORTED_MEDIA_SIGNATURE"
    );
  }

  const normalized = normalizeContentType(declaredContentType);
  if (GENERIC_MIME_TYPES.has(normalized)) return mediaType.mime;

  const declaredType = MIME_TYPES.get(normalized);
  if (!declaredType || declaredType.extension !== mediaType.extension) {
    throw new MediaIngestionError(
      415,
      "Source Content-Type does not match its media bytes.",
      "MEDIA_TYPE_MISMATCH"
    );
  }
  return normalized;
}

export function byteLimitForMediaType(mediaType) {
  return mediaType?.kind === "video" ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES;
}

export function assertByteLimit(size, mediaType) {
  const limit = byteLimitForMediaType(mediaType);
  if (!Number.isSafeInteger(size) || size < 0 || size > limit) {
    throw new MediaIngestionError(
      413,
      `${mediaType?.kind === "video" ? "Video" : "Image"} exceeds the ${
        limit / (1024 * 1024)
      } MiB ingestion limit.`,
      "SOURCE_TOO_LARGE",
      { limitBytes: limit }
    );
  }
}

export function collapseCanonicalAssets(records) {
  const unique = [];
  const duplicates = [];
  const seen = new Map();

  for (const record of records) {
    const key = record?.ingestion?.key;
    if (!key || !seen.has(key)) {
      if (key) seen.set(key, record);
      unique.push(record);
      continue;
    }

    const original = seen.get(key);
    duplicates.push({
      sourceUrl: record.sourceAsset?.url || record.ingestion?.sourceUrl || null,
      sourceKind: record.sourceAsset?.sourceKind || null,
      sourceIndex: record.sourceAsset?.sourceIndex || null,
      url: record.ingestion?.url || null,
      cloudflarePath: record.ingestion?.cloudflarePath || null,
      r2Action: record.ingestion?.r2Action || null,
      r2Reused: record.ingestion?.r2Reused === true,
      r2Uploaded: record.ingestion?.r2Uploaded === true,
      duplicateOfSourceUrl:
        original.sourceAsset?.url || original.ingestion?.sourceUrl || null,
      reason: "duplicate-content",
    });
  }

  return { unique, duplicates };
}

export function safeSourceUrlMetadata(value, maxBytes = 512) {
  let url;
  try {
    url = validatePublicHttpsUrl(value);
  } catch {
    return null;
  }

  url.search = "";
  const serialized = url.href;
  return new TextEncoder().encode(serialized).length <= maxBytes
    ? serialized
    : null;
}

export function normalizeContentType(value) {
  return String(value || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

export function isTemporaryNotionHostedUrl(url) {
  const hostname = url.hostname.toLowerCase();
  const pathname = url.pathname.toLowerCase();

  return (
    hostname === "file.notion.so" ||
    hostname === "secure.notion-static.com" ||
    hostname.endsWith(".notion-static.com") ||
    (hostname.startsWith("prod-files-secure.s3") &&
      hostname.endsWith(".amazonaws.com")) ||
    (hostname.startsWith("s3.") &&
      hostname.endsWith(".amazonaws.com") &&
      pathname.includes("/secure.notion-static.com/"))
  );
}

function detectIsoBaseMediaType(bytes) {
  const boxSize = readUint32(bytes, 0);
  if (boxSize !== 0 && boxSize < 12) return null;
  const majorBrand = ascii(bytes, 8, 4).toLowerCase();
  if (majorBrand === "qt  ") return MEDIA_TYPES.mov;
  if (MP4_BRANDS.has(majorBrand)) return MEDIA_TYPES.mp4;

  const availableBoxSize =
    boxSize === 0 ? bytes.length : Math.min(boxSize, bytes.length);
  for (let offset = 16; offset + 4 <= availableBoxSize; offset += 4) {
    const brand = ascii(bytes, offset, 4).toLowerCase();
    if (brand === "qt  ") return MEDIA_TYPES.mov;
    if (MP4_BRANDS.has(brand)) return MEDIA_TYPES.mp4;
  }
  return null;
}

function isKnownMediaType(mediaType) {
  return Object.values(MEDIA_TYPES).includes(mediaType);
}

function isBlockedIpv4(parts) {
  const address = parts.join(".");
  if (CLOUD_METADATA_IPV4.has(address)) return true;
  const value = ipv4PartsToInteger(parts);
  return BLOCKED_IPV4_CIDRS.some(([network, prefix]) => {
    const mask =
      prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) >>> 0 === (network & mask) >>> 0;
  });
}

function isBlockedIpv6(hostname) {
  const value = ipv6ToBigInt(hostname);
  if (value === null) return true;
  if (value === 0n || value === 1n) return true;

  const high96 = value >> 32n;
  if (high96 === 0n || high96 === 0xffffn) {
    const embedded = Number(value & 0xffffffffn);
    return isBlockedIpv4([
      (embedded >>> 24) & 0xff,
      (embedded >>> 16) & 0xff,
      (embedded >>> 8) & 0xff,
      embedded & 0xff,
    ]);
  }

  if ((value >> 120n) === 0xffn) return true;
  if ((value >> 121n) === 0x7en) return true;
  if ((value >> 118n) === 0x3fan) return true;
  if (matchesIpv6Prefix(value, "fe80::", 10)) return true;
  if (matchesIpv6Prefix(value, "fec0::", 10)) return true;
  if (matchesIpv6Prefix(value, "100::", 64)) return true;
  if (matchesIpv6Prefix(value, "2001:db8::", 32)) return true;
  if (matchesIpv6Prefix(value, "2001:2::", 48)) return true;
  if (matchesIpv6Prefix(value, "2001:10::", 28)) return true;
  if (matchesIpv6Prefix(value, "2001:20::", 28)) return true;
  if (matchesIpv6Prefix(value, "2001:0::", 32)) return true;
  if (matchesIpv6Prefix(value, "2002::", 16)) return true;

  return !matchesIpv6Prefix(value, "2000::", 3);
}

function matchesIpv6Prefix(value, prefixAddress, prefixLength) {
  const prefix = ipv6ToBigInt(prefixAddress);
  if (prefix === null) return false;
  const shift = 128n - BigInt(prefixLength);
  return value >> shift === prefix >> shift;
}

function ipv6ToBigInt(input) {
  let value = stripIpv6Brackets(String(input || "")).toLowerCase();
  if (!value) return null;

  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    const ipv4 = parseIpv4(value.slice(lastColon + 1));
    if (!ipv4) return null;
    value = `${value.slice(0, lastColon)}:${(
      (ipv4[0] << 8) |
      ipv4[1]
    ).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  ) {
    return null;
  }

  const groups = [
    ...left,
    ...Array.from({ length: Math.max(0, missing) }, () => "0"),
    ...right,
  ];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  ) {
    return null;
  }

  return groups.reduce(
    (result, group) => (result << 16n) | BigInt(`0x${group}`),
    0n
  );
}

function parseIpv4(value) {
  const parts = value.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^\d{1,3}$/.test(part))
  ) {
    return null;
  }
  const numbers = parts.map(Number);
  return numbers.every((part) => part >= 0 && part <= 255) ? numbers : null;
}

function ipv4ToInteger(value) {
  return ipv4PartsToInteger(parseIpv4(value));
}

function ipv4PartsToInteger(parts) {
  return (
    ((parts[0] << 24) |
      (parts[1] << 16) |
      (parts[2] << 8) |
      parts[3]) >>>
    0
  );
}

function stripIpv6Brackets(value) {
  return value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
}

function readUint32(bytes, offset) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function ascii(bytes, start, length) {
  let output = "";
  const end = Math.min(bytes.length, start + length);
  for (let index = start; index < end; index += 1) {
    output += String.fromCharCode(bytes[index]);
  }
  return output;
}

function toBytes(value) {
  return value instanceof Uint8Array
    ? value
    : new Uint8Array(value || new ArrayBuffer(0));
}
