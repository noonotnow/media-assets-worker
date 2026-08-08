# Media Assets Worker

Phase 1 Cloudflare Worker for creating rows in Katie's Notion Media Assets database.
R2 upload and restoration are intentionally deferred to Phase 2.

## IDs

```txt
MEDIA_ASSETS_DATABASE_ID=3b08d902-271f-815c-8d9e-fbd9a8989100
POSTS_DATABASE_ID=3a78d902-271f-80fa-b91d-000b638f5907
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

## Notion requirement

Share both databases with the Notion integration under Notion → database menu → Connections.

If Notion returns `object_not_found`, the integration probably does not have access or the database ID is wrong.
