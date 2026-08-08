# Media Assets Worker

Cloudflare Worker that ingests stable Post media into R2 and then registers the
canonical R2 object in Notion Media Assets. R2 is the source of truth; source
URLs are provenance, not the stored asset URL.

Scheduled Post scanning remains deferred. This phase handles authenticated
manual Post ingestion and focused URL ingestion only.

## Architecture

`POST /from-post` performs a two-phase import:

1. Read the Notion Post and extract stable URLs from all supported image and
   thumbnail aliases.
2. Skip temporary Notion-hosted signed file URLs and duplicate normalized
   source URLs.
3. For an exact canonical SHA URL, validate the canonical key and `HEAD` it in
   R2. Missing objects are rejected; canonical-looking URLs are never trusted
   on shape alone.
4. For another path on the exact custom origin, validate and decode the legacy
   key, then read it directly through `MEDIA_BUCKET.get()`. The Worker never
   sends an outbound HTTP request for a bound-bucket source.
5. For any source, first look for completed retry staging under a
   source-fingerprint prefix. If none exists, stream the bound object or fetch
   public HTTPS with at most five manually validated redirects into
   `imports/staging/src-<source-sha256>-<upload-id>`.
6. Inspect leading bytes, validate MIME compatibility, enforce byte limits,
   and incrementally calculate SHA-256 while uploading 16 MiB multipart parts.
7. Derive the content-addressed key. Reuse a compatible existing canonical
   object or stream-copy staging through a second, abortable multipart upload.
   Canonical part uploads have bounded retries.
8. Set immutable cache metadata and R2 custom metadata, verify the canonical
   object with `HEAD`, and only then delete completed staging.
9. After all source assets ingest successfully, query/update/create Notion
   rows using canonical URL/path values.

An explicitly supplied, completed `videos/staging/` object may be read as a
legacy source, but it is never deleted, mutated, or resumed. Existing stuck
multipart uploads are not completed objects and remain untouched; cleanup
still requires a separate, explicit decision.

## Canonical storage

Bucket and public origin:

```txt
R2 bucket: xhs-images
Public origin: https://images.xhs.justlikekatie.com
```

Canonical keys:

```txt
images/sha256/<hash[0:2]>/<hash[2:4]>/<sha256>.<canonical-ext>
videos/sha256/<hash[0:2]>/<hash[2:4]>/<sha256>.<canonical-ext>
```

JPEG is always stored with `.jpg`. Safely identified PNG, WebP, GIF, MP4,
QuickTime/MOV, and WebM containers retain their canonical extension. Notion
Format is written only when the destination schema already offers the matching
option:

| Detected bytes | Canonical extension | Notion Format |
| --- | --- | --- |
| JPEG | `.jpg` | `JPG` |
| PNG | `.png` | `PNG` |
| WebP | `.webp` | omitted |
| GIF | `.gif` | omitted |
| MP4 | `.mp4` | `MP4` |
| QuickTime | `.mov` | omitted |
| WebM | `.webm` | omitted |

Canonical writes use:

```txt
Cache-Control: public, max-age=31536000, immutable
```

Custom metadata includes SHA-256 and upload ID, plus Source Post ID when
available. Source URL metadata omits the query string and is included only
when the result fits the conservative metadata size cap.

Canonical reuse requires all three checks: object size matches, stored
Content-Type is compatible with the canonical extension, and
`customMetadata.sha256` exists and exactly matches the SHA-256 in the key.
Missing hash metadata is not verified.

## Configuration

`wrangler.toml` uses the native binding. Do not add R2 access keys:

```toml
compatibility_flags = ["global_fetch_strictly_public"]

[vars]
R2_PUBLIC_BASE_URL = "https://images.xhs.justlikekatie.com"

[[r2_buckets]]
binding = "MEDIA_BUCKET"
bucket_name = "xhs-images"
```

The strict-public fetch compatibility flag forces user-controlled source
requests through Cloudflare's public front door instead of allowing global
`fetch()` to bypass edge controls for a Worker-owned zone.

Required secrets remain:

```bash
wrangler secret put NOTION_TOKEN
wrangler secret put WORKER_API_KEY
```

The confirmed Notion database/data source IDs and the R2 public base URL are
non-secret Wrangler variables. Share both Notion databases with the Notion
integration under **Connections**.

## Source security model

Every initial and redirect URL is validated independently:

- HTTPS only, with no username/password or fragment.
- Port must be omitted or 443.
- `localhost`, `.localhost`, `.local`, known metadata hostnames, private,
  loopback, link-local, unspecified, multicast, reserved, and cloud metadata
  IPv4/IPv6 literals are rejected.
- Redirects are manual and limited to five hops.
- Source requests use only a fixed `User-Agent` and `Accept`; caller cookies,
  authorization, referrer, and other headers are never forwarded.
- Connection/header wait is capped at 30 seconds. Stream inactivity is capped
  at 30 seconds and total source streaming at 30 minutes.
- `Content-Length` is checked when present, and streamed bytes are counted
  independently when absent or inaccurate.
- Media type comes from bounded leading-byte inspection. HTML/error responses,
  unsupported containers, and MIME/signature disagreements are rejected.
- Exact custom-origin paths outside the canonical SHA namespaces are treated as
  legacy bound-bucket sources. Empty, traversal-like, malformed encoded,
  control-character, backslash, and overlong decoded keys are rejected.
  `imports/staging/` is always internal and cannot be supplied as a source.
- A path claiming `images/sha256/` or `videos/sha256/` must be a fully valid
  canonical key; malformed canonical shards are rejected rather than treated
  as legacy media.

This materially reduces SSRF exposure but does **not** eliminate DNS rebinding:
Workers cannot resolve and pin a hostname to a vetted address for the complete
outbound request. Only use this endpoint as an authenticated production
boundary, monitor source failures, and do not describe the policy as complete
SSRF prevention.

Temporary Notion file URLs remain unqualified. A Post needs a deliberate,
stable public HTTPS source before it can be ingested.

## Limits and runtime considerations

| Media kind | Maximum source size |
| --- | ---: |
| Image | 25 MiB |
| Video | 1 GiB |

The 1 GiB application limit is below R2 multipart limits (5 MiB minimum part
except the final part, 10,000 parts, and multi-terabyte objects). The Worker
uses 16 MiB parts and stays below the 128 MB isolate memory limit by never
buffering a full video. It keeps one part plus bounded stream/hash state in
memory.

Incremental SHA-256 is CPU work. Cloudflare Workers Free allows only 10 ms CPU
per request and is not suitable for this ingestion flow. Workers Paid defaults
to 30 seconds CPU and can be configured up to 300,000 ms:

```toml
[limits]
cpu_ms = 300_000
```

Do not add that override blindly: confirm the account is on Workers Paid and
use Worker CPU metrics with representative large videos first. Workers Free
also allows only 50 subrequests per invocation, while Workers Paid allows
10,000. A fresh 1 GiB ingest uses 64 staging parts and 64 destination parts,
plus source fetch, create/complete, `HEAD`, `GET`, list, and delete operations,
so it cannot fit the Free subrequest budget. The six simultaneous outgoing
connection limit is respected because part operations are sequential.

HTTP Workers have no fixed wall-clock limit while the client remains connected,
but a disconnect can cancel the request; runtime updates provide only a
30-second grace period to in-flight work. The Worker additionally caps each
source or R2 staging stream at 30 minutes. A 1 GiB transfer therefore remains
dependent on source throughput, client connection lifetime, CPU allowance,
subrequest allowance, and runtime updates.

The 30-minute source-staging and canonical-promotion deadlines cover stream
reads, multipart creation, part uploads, completion, and canonical
verification; they do not reset after each part.

The native Workers R2 API has no server-side object copy operation. Canonical
promotion must stream the completed staging object back through the Worker into
a destination multipart upload. On promotion failure, destination multipart is
aborted and completed staging is preserved. A later request for the identical
normalized source URL discovers that staging, verifies and re-hashes it, and
retries promotion without downloading the public source again. Retry still
requires a full staging read, and promotion requires another full staging read;
this is the principal operational limitation for 1 GiB objects. Incomplete R2
multipart uploads are automatically aborted by R2 after seven days if an abort
request itself cannot be confirmed.

R2 rate-limits concurrent writes to the same key. A failed canonical write is
reconciled with a compatible `HEAD` so an identical concurrent winner can be
reused.

## Notion behavior

The Post source aliases remain:

- Images: `Image URLs`, `Images URL`, `Image URL`, `Images`
- Thumbnails: `Thumbnail`, `Thumbnail URL`

Rich text may contain newline-, whitespace-, or comma-separated URLs. A unique
thumbnail becomes Asset Type `Cover` with Canonical Label `Thumbnail`. Other
detected images/videos become one row per Post and canonical object. Within one
Post, different source URLs with identical bytes collapse to one canonical
row/result and appear in the response `duplicates` array with reason
`duplicate-content`.

After R2 success:

- Query exact canonical Cloudflare URL together with the current Source Post.
  A canonical row linked only to another Post is never reused or mutated.
- Query Source Post + every original source URL that collapsed to the canonical
  object. Every matching legacy row is updated in Cloudflare URL, Cloudflare
  Path, Filename, supported Format, Asset Type, Storage Status, Asset Status,
  and Product Lane.
- Otherwise create a new schema-compatible row.

Human notes and unrelated metadata are not replaced during legacy migration.
`Uploaded to Cloudflare` is written only after successful R2 validation and
only when the destination option already exists.

R2 deduplication is global by canonical content hash. Notion catalog identity
is deliberately narrower: `(Source Post, canonical Cloudflare URL)`. Two Posts
with identical bytes share one R2 object but retain separate Media Assets rows,
each linked only to its own Post. This removes cross-Post relation-array
mutation and its lost-update race.

Notion dedupe remains a best-effort query-then-create operation. Concurrent
requests for the same Post and canonical URL can still create duplicate Notion
rows; Durable Object serialization is intentionally deferred for this phase.
R2 writes are content-addressed, so concurrent writes for an identical hash/key
contain identical bytes.

## Endpoints

All endpoints except `GET /health` require:

```txt
Authorization: Bearer <WORKER_API_KEY>
```

| Endpoint | Behavior |
| --- | --- |
| `GET /health` | Public minimal service health; reports only an R2 configured boolean. |
| `GET /test` | Creates the existing Notion test row. It does not ingest media. |
| `GET /post/:id` | Shows simplified Post fields and qualified source assets. |
| `POST /media-assets` | Metadata-only Notion creation. It does not download or ingest a URL and cannot mark a row Uploaded to Cloudflare. |
| `POST /from-post` | Ingests all qualified Post assets to R2, then reconciles Notion rows. |
| `POST /ingest-url` | Ingests one URL to R2 for focused testing; never creates a Notion row. |

### Focused URL ingestion

```bash
curl -X POST "$WORKER_URL/ingest-url" \
  -H "Authorization: Bearer $WORKER_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
    "sourceUrl": "https://public.example/media/photo.jpg",
    "kind": "image"
  }'
```

`kind` is optional and may be `image` or `video`. `postId` is optional and, when
present, must be a Notion page UUID. Unknown request fields are rejected.

Representative result:

```json
{
  "ok": true,
  "result": {
    "sourceUrl": "https://public.example/media/photo.jpg",
    "url": "https://images.xhs.justlikekatie.com/images/sha256/ab/cd/abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789.jpg",
    "cloudflarePath": "/images/sha256/ab/cd/abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789.jpg",
    "r2Action": "uploaded",
    "r2Reused": false,
    "r2Uploaded": true
  }
}
```

### Post ingestion

```bash
curl -X POST "$WORKER_URL/from-post" \
  -H "Authorization: Bearer $WORKER_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"postId":"NOTION_POST_PAGE_UUID"}'
```

Each unique result includes `sourceUrl`, canonical `url`, `cloudflarePath`,
`r2Action`, `stagingResumed`, and `notionRows`. Every Notion row reports its
`id` and action (`created`, `updated`, or `existing`). `reconciledRowIds`
exposes all rows for the current Post that converged to the canonical object;
top-level `notionAction` is `reconciled` when actions differ.
Aggregate counts include source assets, canonical assets,
created/updated/existing rows, deduplicated content, and skipped sources.

### Metadata-only creation

```bash
curl -X POST "$WORKER_URL/media-assets" \
  -H "Authorization: Bearer $WORKER_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
    "name": "Manual metadata row",
    "assetType": "Image",
    "notes": "No source ingestion is performed by this route."
  }'
```

## Failure semantics

- Validation, redirect, MIME, signature, timeout, byte-limit, and source-stream
  failures abort incomplete staging multipart upload and delete its key.
- Legacy same-origin source objects are read-only. Cleanup targets only
  `imports/staging/` retry objects created by this ingestion flow and never the
  supplied legacy key.
- Once staging multipart completes, canonical promotion failure returns
  `R2_CANONICAL_PROMOTION_RETRYABLE` with a safe staging key containing only a
  source hash and upload ID. Completed staging is deliberately preserved.
- A later request for the same normalized source URL resumes from completed
  staging before making any source fetch.
- Canonical promotion uses an independently abortable multipart upload and is
  verified with `HEAD`; staging is deleted only after compatible canonical
  hash, size, and type verification.
- If a canonical key exists with missing or mismatched SHA metadata, the
  request returns `R2_CANONICAL_VERIFY_CONFLICT` with a safe staging key and
  recovery hint. Completed staging remains intact; the unverified canonical
  object must be repaired or removed deliberately.
- Cleanup deletes only the exact staging object that was verified. Concurrent
  retry staging for the same source fingerprint is left for its own request to
  reconcile.
- If staging cleanup itself fails, the request returns an explicit error rather
  than reporting success.
- `/from-post` ingests all sources before making Notion changes. If a later
  source fails, earlier canonical R2 objects may remain and are safely reused
  on retry, but Notion has not yet been changed.
- If Notion fails after R2 succeeds, the canonical object remains the source of
  truth and a retry reconciles the row.
- Errors retain the JSON shape `{ "ok": false, "error": "...", "details": {} }`
  without returning authorization data or redirect/source query strings.

## Local validation and deployment

```bash
npm ci
npm test
npx wrangler deploy --dry-run
```

Manual production sequence:

1. Confirm the `xhs-images` bucket custom domain is exactly
   `images.xhs.justlikekatie.com`.
2. Confirm `NOTION_TOKEN` and `WORKER_API_KEY` already exist as Worker secrets.
3. Run the validation commands above.
4. Deploy with `npm run deploy`.
5. Call public `GET /health`.
6. Call `POST /ingest-url` with a small known public image; confirm the returned
   URL uses the canonical custom domain and the staging prefix is empty.
7. Call `POST /from-post` for a test Post and confirm Notion stores only the
   canonical Cloudflare URL/path.
8. Repeat both calls and confirm R2/Notion actions report reuse/existing.

Do not run any cleanup against `videos/staging/` as part of deployment or
verification.
