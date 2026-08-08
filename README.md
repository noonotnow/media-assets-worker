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

Create or find the Media Asset mapped from a Post:

```bash
curl -X POST https://YOUR-WORKER.workers.dev/from-post \
  -H "Authorization: Bearer YOUR_WORKER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"postId":"NOTION_POST_PAGE_UUID"}'
```

The response includes `created: true` for a new row or `created: false` when
deduplication finds an existing row.

## Post qualification and mapping

A Post qualifies only when the first usable image field contains a complete,
valid `http://` or `https://` URL. Image aliases are checked first
(`Images URL`, `Image URL`, `Images`), followed by thumbnail aliases
(`Thumbnail`, `Thumbnail URL`). Image URL wins over thumbnail. File-type Notion
properties are supported only for external HTTP(S) URLs; temporary
Notion-hosted file URLs do not qualify. R2 identifiers, relative paths,
malformed URLs, and other protocols do not qualify.

The selected URL becomes `Cloudflare URL`; its URL pathname becomes
`Cloudflare Path` when available. The mapper reads Headline/title, Platform,
Series, Production Mode, Media source, Campaign / event name, Campaign notes /
requirements, Requirements, Notes, and Needs media. It writes only destination
properties whose types are confirmed by the live Media Assets data-source
schema. Select/status values are written only when the option already exists;
other source context is retained in Media Asset Notes.

If Media Assets has a `Source Post` relation property, it is populated and used
for deduplication. Otherwise, deduplication falls back to exact
`Cloudflare URL` equality when that URL property exists. The Media Assets schema
is cached briefly by each Worker isolate.

All endpoints except `GET /health` require
`Authorization: Bearer YOUR_WORKER_API_KEY`.

## Notion requirement

Share both databases with the Notion integration under Notion → database menu → Connections.

If Notion returns `object_not_found`, the integration probably does not have access or the database ID is wrong.

`POSTS_DATABASE_ID` and `POSTS_DATA_SOURCE_ID` are confirmed configuration for
future scheduled scanning. Manual Post lookup uses `GET /v1/pages/{postId}`
directly, so neither variable is required by `GET /post/:id` or
`POST /from-post`.
