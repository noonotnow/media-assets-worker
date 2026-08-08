# Media Assets Worker

Phase 1.5 Cloudflare Worker for creating rows in Katie's Notion Media Assets
database, including manual Post → Media Asset mapping.

R2 upload, R2 restoration, scheduled Post scans, and file fallback are
intentionally deferred. The scheduled scan will be added after manual mapping
has been proven against real Post rows.

## IDs

```txt
MEDIA_ASSETS_DATABASE_ID=7c86b4f3-1f36-4f82-96d8-1fe87962fcc0
MEDIA_ASSETS_DATA_SOURCE_ID=97d14043-3d6b-46db-959b-d8a8d55feee3
POSTS_DATABASE_ID=3068d902-271f-810e-82e8-f878238d58dd
POSTS_DATA_SOURCE_ID=3068d902-271f-8111-89ac-000bbaa74214
```

## Setup

```bash
npm install
wrangler secret put NOTION_TOKEN
wrangler secret put WORKER_API_KEY
npm run dev
```

## Deploy

```bash
npm run deploy
```

## Test endpoints

Health check:

```bash
curl https://YOUR-WORKER.workers.dev/health
```

Create a test media asset:

```bash
curl https://YOUR-WORKER.workers.dev/test \
  -H "Authorization: Bearer $WORKER_API_KEY"
```

Create a custom media asset:

```bash
curl -X POST https://YOUR-WORKER.workers.dev/media-assets \
  -H "Authorization: Bearer $WORKER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Day 8 cover",
    "assetType": "Cover",
    "format": "PNG",
    "series": "念无双 第二季等待室",
    "productLane": "Rednote freebie",
    "textStatus": "Day text",
    "notes": "Created from worker upload."
  }'
```

Inspect the source fields used for mapping a Post:

```bash
curl https://YOUR-WORKER.workers.dev/post/NOTION_POST_PAGE_UUID \
  -H "Authorization: Bearer YOUR_WORKER_API_KEY"
```

Create or find every Media Asset mapped from a Post:

```bash
curl -X POST https://YOUR-WORKER.workers.dev/from-post \
  -H "Authorization: Bearer YOUR_WORKER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"postId":"NOTION_POST_PAGE_UUID"}'
```

The response aggregates all qualified source URLs:

```json
{
  "ok": true,
  "totalAssets": 3,
  "created": 2,
  "existing": 1,
  "skipped": 1,
  "results": [
    {
      "url": "https://pub-example.r2.dev/day-4/photo.jpg",
      "created": false,
      "id": "existing-notion-row-id",
      "rowUrl": "https://www.notion.so/existing-notion-row-id",
      "sourceKind": "image",
      "sourceIndex": 1
    }
  ]
}
```

`skipped` counts rejected temporary URLs and duplicate normalized URLs. A
request with no stable qualifying URLs returns a meaningful `409` response.

## Post qualification and mapping

A Post qualifies when any supported image or thumbnail property contains a
stable external `http://` or `https://` URL. Image aliases are `Image URLs`,
`Images URL`, `Image URL`, and `Images`; thumbnail aliases are `Thumbnail` and
`Thumbnail URL`. Rich text may contain newline-, whitespace-, or comma-separated
URLs. Temporary signed Notion-hosted URLs, R2 identifiers, relative paths,
malformed URLs, and other protocols do not qualify.

Each unique normalized image URL produces one Media Assets row in source order.
Rows are named `Headline — asset 01`, `Headline — asset 02`, and so on. A
thumbnail that is not already in the image list produces a separate
`Headline — thumbnail` row with Asset Type `Cover` and Canonical Label
`Thumbnail`. Pathname extensions infer Image versus Video; Format is limited to
existing JPG, PNG, and MP4 options.

The URL becomes `Cloudflare URL`; its pathname becomes `Cloudflare Path` and
provides Filename. The mapper reads Headline/title, Platform, Series, Production
Mode, Media source, Campaign / event name, campaign requirements, Notes, and
Needs media. It sets Product Lane to `Rednote post` when that option exists.
Stable R2/Cloudflare URLs use `Uploaded to Cloudflare` for both storage and
asset status when those options exist. Other source context is retained in
Media Asset Notes.

Deduplication always includes exact `Cloudflare URL` equality. When Media Assets
has a `Source Post` relation, the query requires both that relation and the
exact URL; a relation match alone never suppresses another asset. Without the
relation, exact URL is the fallback. The Media Assets schema is cached briefly
by each Worker isolate.

All endpoints except `GET /health` require
`Authorization: Bearer YOUR_WORKER_API_KEY`.

## Notion requirement

Share both databases with the Notion integration under Notion → database menu → Connections.

If Notion returns `object_not_found`, the integration probably does not have access or the database ID is wrong.

`POSTS_DATABASE_ID` and `POSTS_DATA_SOURCE_ID` are groundwork for a later
scheduled scan. Manual Post lookup uses `GET /v1/pages/{postId}` directly and
does not require either variable at runtime.
