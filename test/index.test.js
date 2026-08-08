import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import worker, {
  buildCanonicalMediaAssetUpdateProperties,
  buildExistingMediaAssetFilter,
  buildFromPostMediaAssetPayload,
  buildPostAssets,
  extractStableAssetUrls,
  qualifyPostFields,
  simplifyPostPage,
} from "../src/index.js";
import { CANONICAL_R2_ORIGIN } from "../src/media-ingestion.js";
import { MemoryR2Bucket } from "./helpers/memory-r2.js";

const POST_ID = "3068d902-271f-810e-82e8-f878238d58dd";
const SECOND_POST_ID = "4068d902-271f-810e-82e8-f878238d58aa";

test("extracts newline image URLs in source order and infers image and video metadata", () => {
  const post = simplifyPostPage({
    id: POST_ID,
    url: `https://www.notion.so/${POST_ID}`,
    properties: {
      Headline: {
        type: "title",
        title: [{ plain_text: "Day 4" }],
      },
      "Image URLs": {
        type: "rich_text",
        rich_text: [
          {
            plain_text:
              "https://assets.example.com/day-4/photo.jpeg\nhttps://assets.example.com/day-4/clip.mp4",
          },
        ],
      },
    },
  });

  assert.equal(post.assets.length, 2);
  assert.deepEqual(
    post.assets.map(({ url, assetType, format, name, sourceIndex }) => ({
      url,
      assetType,
      format,
      name,
      sourceIndex,
    })),
    [
      {
        url: "https://assets.example.com/day-4/photo.jpeg",
        assetType: "Image",
        format: "JPG",
        name: "Day 4 — asset 01",
        sourceIndex: 1,
      },
      {
        url: "https://assets.example.com/day-4/clip.mp4",
        assetType: "Video",
        format: "MP4",
        name: "Day 4 — asset 02",
        sourceIndex: 2,
      },
    ]
  );
  assert.equal(post.qualification.cloudflareUrl, post.assets[0].url);
  assert.equal(post.qualification.totalAssets, 2);
});

test("merges URLs across every matching image alias", () => {
  const post = simplifyPostPage({
    id: POST_ID,
    properties: {
      Headline: {
        type: "title",
        title: [{ plain_text: "Aliases" }],
      },
      "Image URLs": {
        type: "rich_text",
        rich_text: [],
      },
      "Images URL": {
        type: "url",
        url: "https://assets.example.com/from-url.png",
      },
      Images: {
        type: "files",
        files: [
          {
            external: {
              url: "https://assets.example.com/from-files.webp",
            },
          },
        ],
      },
    },
  });

  assert.deepEqual(
    post.assets.map((asset) => ({
      url: asset.url,
      sourceProperty: asset.sourceProperty,
      sourceIndex: asset.sourceIndex,
    })),
    [
      {
        url: "https://assets.example.com/from-url.png",
        sourceProperty: "Images URL",
        sourceIndex: 1,
      },
      {
        url: "https://assets.example.com/from-files.webp",
        sourceProperty: "Images",
        sourceIndex: 2,
      },
    ]
  );
});

test("parses whitespace and comma-separated values, normalizes, and rejects temporary Notion URLs", () => {
  const urls = extractStableAssetUrls([
    "https://assets.example.com/a.png, https://assets.example.com/b.webp",
    "https://assets.example.com/a.png#duplicate",
    "https://prod-files-secure.s3.us-west-2.amazonaws.com/signed?X-Amz-Signature=temporary",
    "https://secure.notion-static.com/file.jpg https://assets.example.com/c.jpg",
  ]);

  assert.deepEqual(urls, [
    "https://assets.example.com/a.png",
    "https://assets.example.com/b.webp",
    "https://assets.example.com/c.jpg",
  ]);
});

test("strips prose punctuation while preserving query syntax and balanced delimiters", () => {
  const urls = extractStableAssetUrls(
    "Use https://assets.example.com/photo.jpg. " +
      "Then (https://assets.example.com/crop_(final).png). " +
      "Keep https://assets.example.com/download?next=%2Fmedia%3Fid%3D1&tags=a,b! " +
      "Also https://assets.example.com/one.jpg,https://assets.example.com/two.jpg;"
  );

  assert.deepEqual(urls, [
    "https://assets.example.com/photo.jpg",
    "https://assets.example.com/crop_(final).png",
    "https://assets.example.com/download?next=%2Fmedia%3Fid%3D1&tags=a,b",
    "https://assets.example.com/one.jpg",
    "https://assets.example.com/two.jpg",
  ]);
});

test("deduplicates a thumbnail already present in image URLs", () => {
  const qualification = qualifyPostFields({
    headline: { value: "Duplicate thumbnail" },
    imageUrl: {
      propertyName: "Images URL",
      value:
        "https://assets.example.com/a.png\nhttps://assets.example.com/thumb.jpg",
    },
    thumbnail: {
      propertyName: "Thumbnail URL",
      value: "https://assets.example.com/thumb.jpg",
    },
  });

  assert.equal(qualification.totalAssets, 2);
  assert.equal(qualification.skipped, 1);
  assert.deepEqual(
    qualification.assets.map((asset) => asset.sourceKind),
    ["image", "image"]
  );
});

test("adds a unique thumbnail as a Cover with an explicit label", () => {
  const result = buildPostAssets({
    headline: { value: "Launch" },
    imageUrl: {
      propertyName: "Image URL",
      value: "https://assets.example.com/launch.png",
    },
    thumbnail: {
      propertyName: "Thumbnail",
      value: "https://assets.example.com/launch-thumb.jpg",
    },
  });
  const thumbnail = result.assets[1];

  assert.deepEqual(
    {
      name: thumbnail.name,
      assetType: thumbnail.assetType,
      canonicalLabel: thumbnail.canonicalLabel,
      format: thumbnail.format,
      sourceKind: thumbnail.sourceKind,
      sourceIndex: thumbnail.sourceIndex,
    },
    {
      name: "Launch — thumbnail",
      assetType: "Cover",
      canonicalLabel: "Thumbnail",
      format: "JPG",
      sourceKind: "thumbnail",
      sourceIndex: 1,
    }
  );
});

test("builds schema-compatible properties for each asset", () => {
  const post = {
    id: POST_ID,
    url: `https://www.notion.so/${POST_ID}`,
    fields: {
      headline: { value: "Launch" },
      platform: { value: "Instagram" },
      series: { value: "Launch" },
      productionMode: { value: "Studio" },
      mediaSource: null,
      campaignName: { value: "Fall campaign" },
      campaignNotes: null,
      requirements: { value: "Square crop" },
      notes: { value: "Approved" },
      needsMedia: { value: true },
    },
  };
  const thumbnail = {
    ...buildPostAssets({
      headline: post.fields.headline,
      imageUrl: null,
      thumbnail: {
        propertyName: "Thumbnail URL",
        value: "https://assets.example.com/launch.jpg",
      },
    }).assets[0],
    url: `${CANONICAL_R2_ORIGIN}/images/sha256/ab/ab/${"ab".repeat(32)}.jpg`,
    path: `/images/sha256/ab/ab/${"ab".repeat(32)}.jpg`,
    filename: `${"ab".repeat(32)}.jpg`,
    r2Stored: true,
  };
  const schema = destinationSchema();

  const payload = buildFromPostMediaAssetPayload(
    {
      MEDIA_ASSETS_DATA_SOURCE_ID: "media-assets-source",
      R2_PUBLIC_BASE_URL: CANONICAL_R2_ORIGIN,
    },
    post,
    schema,
    thumbnail
  );

  assert.deepEqual(payload.properties["Source Post"], {
    relation: [{ id: POST_ID }],
  });
  assert.deepEqual(payload.properties["Asset Type"], {
    select: { name: "Cover" },
  });
  assert.deepEqual(payload.properties["Canonical Label"], {
    rich_text: [{ text: { content: "Thumbnail" } }],
  });
  assert.deepEqual(payload.properties["Product Lane"], {
    select: { name: "Rednote post" },
  });
  assert.deepEqual(payload.properties["Asset Status"], {
    status: { name: "Uploaded to Cloudflare" },
  });
  assert.deepEqual(payload.properties["Storage Status"], {
    select: { name: "Uploaded to Cloudflare" },
  });
  assert.deepEqual(payload.properties.Format, { select: { name: "JPG" } });
  assert.match(
    payload.properties.Notes.rich_text[0].text.content,
    /Requirements: Square crop/
  );
});

test("dedupe filter requires Source Post and exact canonical URL", () => {
  const withRelation = buildExistingMediaAssetFilter(
    destinationSchema(),
    POST_ID,
    "https://assets.example.com/a.png"
  );
  const withoutRelation = buildExistingMediaAssetFilter(
    {
      "Cloudflare URL": { type: "url", url: {} },
    },
    POST_ID,
    "https://assets.example.com/a.png"
  );
  const withoutUrl = buildExistingMediaAssetFilter(
    {
      "Source Post": { type: "relation", relation: {} },
    },
    POST_ID,
    "https://assets.example.com/a.png"
  );

  assert.deepEqual(withRelation, {
    and: [
      {
        property: "Source Post",
        relation: { contains: POST_ID },
      },
      {
        property: "Cloudflare URL",
        url: { equals: "https://assets.example.com/a.png" },
      },
    ],
  });
  assert.equal(withoutRelation, null);
  assert.equal(withoutUrl, null);
});

test("legacy row updates include only managed canonical fields", () => {
  const properties = buildCanonicalMediaAssetUpdateProperties(
    destinationSchema(),
    {
      url: `${CANONICAL_R2_ORIGIN}/images/sha256/ab/ab/${"ab".repeat(
        32
      )}.webp`,
      path: `/images/sha256/ab/ab/${"ab".repeat(32)}.webp`,
      filename: `${"ab".repeat(32)}.webp`,
      format: null,
      assetType: "Image",
      r2Stored: true,
    }
  );
  assert.equal(properties.Format, undefined);
  assert.equal(properties.Notes, undefined);
  assert.equal(properties.Name, undefined);
  assert.deepEqual(properties["Asset Status"], {
    status: { name: "Uploaded to Cloudflare" },
  });
  assert.deepEqual(properties["Product Lane"], {
    select: { name: "Rednote post" },
  });

});

test("POST /from-post ingests to R2, updates a legacy row, and reuses canonical rows", async () => {
  const originalFetch = globalThis.fetch;
  const queryBodies = [];
  const createBodies = [];
  const updateBodies = [];
  const bucket = new MemoryR2Bucket();
  const imageBytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1,
  ]);
  const videoBytes = isoBaseMedia("isom");
  const imageUrl = canonicalUrlForBytes(imageBytes, "images", "png");
  const videoUrl = canonicalUrlForBytes(videoBytes, "videos", "mp4");
  const rowsById = new Map([
    [
      "legacy-row",
      notionMediaRow(
        "legacy-row",
        "https://assets.example.com/a.png",
        [POST_ID]
      ),
    ],
  ]);

  globalThis.fetch = async (url, init = {}) => {
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname;
    if (parsedUrl.hostname === "assets.example.com") {
      if (path === "/a.png") {
        return mediaResponse(imageBytes, "image/png");
      }
      if (path === "/b.mov") {
        return mediaResponse(videoBytes, "video/mp4");
      }
      throw new Error(`Unexpected source request: ${path}`);
    }
    if (path === `/v1/pages/${POST_ID}`) {
      return notionResponse({
        id: POST_ID,
        url: `https://www.notion.so/${POST_ID}`,
        properties: {
          Headline: {
            type: "title",
            title: [{ plain_text: "Aggregate" }],
          },
          "Image URLs": {
            type: "url",
            url:
              "https://assets.example.com/a.png https://assets.example.com/b.mov",
          },
        },
      });
    }
    if (path === "/v1/data_sources/aggregate-test-source") {
      return notionResponse({ properties: destinationSchema() });
    }
    if (path.endsWith("/query")) {
      const body = JSON.parse(init.body);
      queryBodies.push(body);
      const assetUrl = body.filter.and
        ? body.filter.and[1].url.equals
        : body.filter.url.equals;
      const requiredPost = body.filter.and
        ? body.filter.and[0].relation.contains
        : null;
      const results = [...rowsById.values()].filter((page) => {
        const matchesUrl =
          page.properties["Cloudflare URL"]?.url === assetUrl;
        const matchesPost =
          !requiredPost ||
          page.properties["Source Post"].relation.some(
            (relation) => relation.id === requiredPost
          );
        return matchesUrl && matchesPost;
      });
      return notionResponse({
        results,
        has_more: false,
      });
    }
    const pageMatch = path.match(/^\/v1\/pages\/([^/]+)$/);
    if (pageMatch && (init.method || "GET") === "GET") {
      const page = rowsById.get(pageMatch[1]);
      if (page) return notionResponse(page);
    }
    if (pageMatch && init.method === "PATCH") {
      const body = JSON.parse(init.body);
      updateBodies.push(body);
      const page = rowsById.get(pageMatch[1]);
      page.properties = { ...page.properties, ...body.properties };
      rowsById.set(page.id, page);
      return notionResponse(page);
    }
    if (path === "/v1/pages" && init.method === "POST") {
      const body = JSON.parse(init.body);
      createBodies.push(body);
      const page = {
        id: "created-row",
        url: "https://www.notion.so/created-row",
        properties: body.properties,
      };
      rowsById.set(page.id, page);
      return notionResponse(page);
    }
    throw new Error(`Unexpected Notion request: ${init.method || "GET"} ${path}`);
  };

  try {
    const callFromPost = () =>
      worker.fetch(
        new Request("https://worker.example/from-post", {
          method: "POST",
          headers: {
            Authorization: "Bearer test-key",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ postId: POST_ID }),
        }),
        {
          NOTION_TOKEN: "test-token",
          WORKER_API_KEY: "test-key",
          MEDIA_ASSETS_DATA_SOURCE_ID: "aggregate-test-source",
          MEDIA_BUCKET: bucket,
          R2_PUBLIC_BASE_URL: CANONICAL_R2_ORIGIN,
        }
      );
    const response = await callFromPost();
    const body = await response.json();

    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(
      {
        ok: body.ok,
        sourceAssets: body.sourceAssets,
        totalAssets: body.totalAssets,
        created: body.created,
        updated: body.updated,
        existing: body.existing,
        deduplicated: body.deduplicated,
        skipped: body.skipped,
      },
      {
        ok: true,
        sourceAssets: 2,
        totalAssets: 2,
        created: 1,
        updated: 1,
        existing: 0,
        deduplicated: 0,
        skipped: 0,
      }
    );
    assert.deepEqual(
      body.results.map((result) => ({
        sourceUrl: result.sourceUrl,
        url: result.url,
        r2Action: result.r2Action,
        notionAction: result.notionAction,
        id: result.id,
        sourceKind: result.sourceKind,
        sourceIndex: result.sourceIndex,
      })),
      [
        {
          sourceUrl: "https://assets.example.com/a.png",
          url: imageUrl,
          r2Action: "uploaded",
          notionAction: "updated",
          id: "legacy-row",
          sourceKind: "image",
          sourceIndex: 1,
        },
        {
          sourceUrl: "https://assets.example.com/b.mov",
          url: videoUrl,
          r2Action: "uploaded",
          notionAction: "created",
          id: "created-row",
          sourceKind: "image",
          sourceIndex: 2,
        },
      ]
    );

    const repeatResponse = await callFromPost();
    const repeatBody = await repeatResponse.json();
    assert.deepEqual(
      {
        totalAssets: repeatBody.totalAssets,
        created: repeatBody.created,
        updated: repeatBody.updated,
        existing: repeatBody.existing,
      },
      { totalAssets: 2, created: 0, updated: 0, existing: 2 }
    );
    assert.deepEqual(
      repeatBody.results.map((result) => ({
        r2Action: result.r2Action,
        notionAction: result.notionAction,
      })),
      [
        { r2Action: "reused", notionAction: "existing" },
        { r2Action: "reused", notionAction: "existing" },
      ]
    );
    assert.equal(queryBodies.length, 8);
    assert.equal(
      queryBodies[1].filter.and[1].url.equals,
      "https://assets.example.com/a.png"
    );
    assert.equal(createBodies.length, 1);
    assert.deepEqual(createBodies[0].properties["Asset Type"], {
      select: { name: "Video" },
    });
    assert.deepEqual(createBodies[0].properties.Format, {
      select: { name: "MP4" },
    });
    assert.equal(updateBodies.length, 1);
    assert.equal(
      updateBodies[0].properties["Cloudflare URL"].url,
      imageUrl
    );
    assert.equal(updateBodies[0].properties.Notes, undefined);
    assert.deepEqual(updateBodies[0].properties["Storage Status"], {
      select: { name: "Uploaded to Cloudflare" },
    });
    assert.deepEqual(bucket.stagingKeys(), []);
    assert.ok(
      await bucket.head(imageUrl.slice(`${CANONICAL_R2_ORIGIN}/`.length))
    );
    assert.ok(
      await bucket.head(videoUrl.slice(`${CANONICAL_R2_ORIGIN}/`.length))
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /from-post reconciles every legacy row that collapses to one canonical object", async () => {
  const originalFetch = globalThis.fetch;
  const bucket = new MemoryR2Bucket();
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7,
  ]);
  const canonicalUrl = canonicalUrlForBytes(bytes, "images", "png");
  const rowsById = new Map([
    [
      "legacy-a",
      {
        ...notionMediaRow(
          "legacy-a",
          "https://assets.example.com/a.png",
          [POST_ID]
        ),
        properties: {
          ...notionMediaRow(
            "legacy-a",
            "https://assets.example.com/a.png",
            [POST_ID]
          ).properties,
          Notes: { type: "rich_text", rich_text: [{ plain_text: "Keep A" }] },
        },
      },
    ],
    [
      "legacy-b",
      {
        ...notionMediaRow(
          "legacy-b",
          "https://cdn.example.com/b.png",
          [POST_ID]
        ),
        properties: {
          ...notionMediaRow(
            "legacy-b",
            "https://cdn.example.com/b.png",
            [POST_ID]
          ).properties,
          Notes: { type: "rich_text", rich_text: [{ plain_text: "Keep B" }] },
        },
      },
    ],
  ]);
  const patchedIds = [];

  globalThis.fetch = async (url, init = {}) => {
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname;
    if (["assets.example.com", "cdn.example.com"].includes(parsedUrl.hostname)) {
      return mediaResponse(bytes, "image/png");
    }
    if (path === `/v1/pages/${POST_ID}`) {
      return notionResponse({
        id: POST_ID,
        url: `https://www.notion.so/${POST_ID}`,
        properties: {
          Headline: {
            type: "title",
            title: [{ plain_text: "Same bytes" }],
          },
          "Image URLs": {
            type: "rich_text",
            rich_text: [
              {
                plain_text:
                  "https://assets.example.com/a.png https://cdn.example.com/b.png",
              },
            ],
          },
        },
      });
    }
    if (path === "/v1/data_sources/legacy-convergence-source") {
      return notionResponse({ properties: destinationSchema() });
    }
    if (path.endsWith("/query")) {
      const body = JSON.parse(init.body);
      const assetUrl = body.filter.and
        ? body.filter.and[1].url.equals
        : body.filter.url.equals;
      return notionResponse({
        results: [...rowsById.values()].filter(
          (page) => page.properties["Cloudflare URL"].url === assetUrl
        ),
        has_more: false,
      });
    }
    const pageMatch = path.match(/^\/v1\/pages\/([^/]+)$/);
    if (pageMatch && (init.method || "GET") === "GET") {
      return notionResponse(rowsById.get(pageMatch[1]));
    }
    if (pageMatch && init.method === "PATCH") {
      const body = JSON.parse(init.body);
      const page = rowsById.get(pageMatch[1]);
      patchedIds.push(page.id);
      page.properties = { ...page.properties, ...body.properties };
      return notionResponse(page);
    }
    if (path === "/v1/pages" && init.method === "POST") {
      throw new Error("All matching legacy rows should be migrated.");
    }
    throw new Error(`Unexpected request: ${init.method || "GET"} ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://worker.example/from-post", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ postId: POST_ID }),
      }),
      {
        NOTION_TOKEN: "test-token",
        WORKER_API_KEY: "test-key",
        MEDIA_ASSETS_DATA_SOURCE_ID: "legacy-convergence-source",
        MEDIA_BUCKET: bucket,
        R2_PUBLIC_BASE_URL: CANONICAL_R2_ORIGIN,
      }
    );
    const body = await response.json();

    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(
      {
        sourceAssets: body.sourceAssets,
        totalAssets: body.totalAssets,
        updated: body.updated,
        created: body.created,
        deduplicated: body.deduplicated,
      },
      {
        sourceAssets: 2,
        totalAssets: 1,
        updated: 2,
        created: 0,
        deduplicated: 1,
      }
    );
    assert.deepEqual(body.results[0].reconciledRowIds, [
      "legacy-a",
      "legacy-b",
    ]);
    assert.deepEqual(
      body.results[0].notionRows.map(({ id, action }) => ({ id, action })),
      [
        { id: "legacy-a", action: "updated" },
        { id: "legacy-b", action: "updated" },
      ]
    );
    assert.deepEqual(patchedIds.sort(), ["legacy-a", "legacy-b"]);
    assert.equal(
      rowsById.get("legacy-a").properties["Cloudflare URL"].url,
      canonicalUrl
    );
    assert.equal(
      rowsById.get("legacy-b").properties["Cloudflare URL"].url,
      canonicalUrl
    );
    assert.equal(
      rowsById.get("legacy-a").properties.Notes.rich_text[0].plain_text,
      "Keep A"
    );
    assert.equal(
      rowsById.get("legacy-b").properties.Notes.rich_text[0].plain_text,
      "Keep B"
    );
    assert.equal(body.duplicates[0].reason, "duplicate-content");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("identical bytes create separate Post-scoped rows over one canonical R2 object", async () => {
  const originalFetch = globalThis.fetch;
  const bucket = new MemoryR2Bucket();
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9,
  ]);
  const canonicalUrl = canonicalUrlForBytes(bytes, "images", "png");
  const rows = [];

  globalThis.fetch = async (url, init = {}) => {
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname;
    if (parsedUrl.hostname === "assets.example.com") {
      return mediaResponse(bytes, "image/png");
    }
    const sourcePostId = [POST_ID, SECOND_POST_ID].find(
      (postId) => path === `/v1/pages/${postId}`
    );
    if (sourcePostId) {
      return notionResponse({
        id: sourcePostId,
        url: `https://www.notion.so/${sourcePostId}`,
        properties: {
          Headline: {
            type: "title",
            title: [{ plain_text: `Post ${sourcePostId.slice(0, 4)}` }],
          },
          "Image URL": {
            type: "url",
            url: "https://assets.example.com/shared.png",
          },
        },
      });
    }
    if (path === "/v1/data_sources/post-scoped-source") {
      return notionResponse({ properties: destinationSchema() });
    }
    if (path.endsWith("/query")) {
      const body = JSON.parse(init.body);
      const postId = body.filter.and[0].relation.contains;
      const assetUrl = body.filter.and[1].url.equals;
      return notionResponse({
        results: rows.filter(
          (page) =>
            page.properties["Cloudflare URL"].url === assetUrl &&
            page.properties["Source Post"].relation.some(
              (relation) => relation.id === postId
            )
        ),
        has_more: false,
      });
    }
    if (path === "/v1/pages" && init.method === "POST") {
      const body = JSON.parse(init.body);
      const page = {
        id: `post-scoped-row-${rows.length + 1}`,
        url: `https://www.notion.so/post-scoped-row-${rows.length + 1}`,
        properties: body.properties,
      };
      rows.push(page);
      return notionResponse(page);
    }
    if (init.method === "PATCH") {
      throw new Error("Cross-Post canonical rows must never be mutated.");
    }
    throw new Error(`Unexpected request: ${init.method || "GET"} ${url}`);
  };

  const env = {
    NOTION_TOKEN: "test-token",
    WORKER_API_KEY: "test-key",
    MEDIA_ASSETS_DATA_SOURCE_ID: "post-scoped-source",
    MEDIA_BUCKET: bucket,
    R2_PUBLIC_BASE_URL: CANONICAL_R2_ORIGIN,
  };
  const ingestPost = async (postId) => {
    const response = await worker.fetch(
      new Request("https://worker.example/from-post", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ postId }),
      }),
      env
    );
    return { response, body: await response.json() };
  };

  try {
    const first = await ingestPost(POST_ID);
    const second = await ingestPost(SECOND_POST_ID);
    const repeat = await ingestPost(POST_ID);

    assert.equal(first.response.status, 200, JSON.stringify(first.body));
    assert.equal(second.response.status, 200, JSON.stringify(second.body));
    assert.equal(repeat.response.status, 200, JSON.stringify(repeat.body));
    assert.equal(first.body.results[0].notionAction, "created");
    assert.equal(second.body.results[0].notionAction, "created");
    assert.equal(repeat.body.results[0].notionAction, "existing");
    assert.equal(first.body.results[0].url, canonicalUrl);
    assert.equal(second.body.results[0].url, canonicalUrl);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((page) =>
        page.properties["Source Post"].relation.map((relation) => relation.id)
      ),
      [[POST_ID], [SECOND_POST_ID]]
    );
    assert.notEqual(rows[0].id, rows[1].id);
    assert.deepEqual(
      [...bucket.objects.keys()].filter(
        (key) => !key.startsWith("imports/staging/")
      ),
      [canonicalUrl.slice(`${CANONICAL_R2_ORIGIN}/`.length)]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /ingest-url stores media without creating a Notion row", async () => {
  const originalFetch = globalThis.fetch;
  const bucket = new MemoryR2Bucket();
  const bytes = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x01,
  ]);
  let sourceRequests = 0;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === "assets.example.com") {
      sourceRequests += 1;
      return mediaResponse(bytes, "image/jpeg");
    }
    throw new Error("POST /ingest-url must not call Notion.");
  };

  try {
    const response = await worker.fetch(
      new Request("https://worker.example/ingest-url", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sourceUrl: "https://assets.example.com/focused-test",
          kind: "image",
        }),
      }),
      {
        NOTION_TOKEN: "test-token",
        WORKER_API_KEY: "test-key",
        MEDIA_ASSETS_DATA_SOURCE_ID: "media-assets-source",
        MEDIA_BUCKET: bucket,
        R2_PUBLIC_BASE_URL: CANONICAL_R2_ORIGIN,
      }
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.result.sourceUrl, "https://assets.example.com/focused-test");
    assert.equal(body.result.r2Action, "uploaded");
    assert.equal(body.result.extension, "jpg");
    assert.equal(sourceRequests, 1);
    assert.deepEqual(bucket.stagingKeys(), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GET /health remains public and reports R2 readiness without details", async () => {
  const env = {
    NOTION_TOKEN: "test-token",
    WORKER_API_KEY: "test-key",
    MEDIA_ASSETS_DATA_SOURCE_ID: "media-assets-source",
    MEDIA_BUCKET: new MemoryR2Bucket(),
    R2_PUBLIC_BASE_URL: CANONICAL_R2_ORIGIN,
  };
  const unauthorized = await worker.fetch(
    new Request("https://worker.example/health"),
    env
  );
  const authorized = await worker.fetch(
    new Request("https://worker.example/health", {
      headers: { Authorization: "Bearer test-key" },
    }),
    env
  );
  const body = await authorized.json();

  assert.equal(unauthorized.status, 200);
  assert.equal(authorized.status, 200);
  assert.deepEqual(body, {
    ok: true,
    service: "media-assets-worker",
    r2Configured: true,
  });

  const unconfigured = await worker.fetch(
    new Request("https://worker.example/health"),
    {}
  );
  assert.deepEqual(await unconfigured.json(), {
    ok: true,
    service: "media-assets-worker",
    r2Configured: false,
  });

  const protectedResponse = await worker.fetch(
    new Request("https://worker.example/ingest-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceUrl: "https://assets.example.com/protected.png",
      }),
    }),
    env
  );
  assert.equal(protectedResponse.status, 401);
});

test("metadata-only POST /media-assets cannot claim an R2 upload", async () => {
  const response = await worker.fetch(
    new Request("https://worker.example/media-assets", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Unsafe metadata claim",
        storageStatus: "Uploaded to Cloudflare",
      }),
    }),
    {
      NOTION_TOKEN: "test-token",
      WORKER_API_KEY: "test-key",
      MEDIA_ASSETS_DATA_SOURCE_ID: "media-assets-source",
      MEDIA_BUCKET: new MemoryR2Bucket(),
      R2_PUBLIC_BASE_URL: CANONICAL_R2_ORIGIN,
    }
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.match(body.error, /metadata-only/);
});

test("temporary-only Posts remain unqualified", () => {
  const post = simplifyPostPage({
    id: POST_ID,
    properties: {
      Headline: {
        type: "title",
        title: [{ plain_text: "Temporary upload" }],
      },
      Images: {
        type: "files",
        files: [
          {
            type: "file",
            file: {
              url: "https://prod-files-secure.s3.us-west-2.amazonaws.com/signed",
              expiry_time: "2026-08-08T08:00:00.000Z",
            },
          },
          {
            type: "file",
            file: {
              url: "https://prod-files-secure.s3.us-west-2.amazonaws.com/signed",
              expiry_time: "2026-08-08T08:00:00.000Z",
            },
          },
        ],
      },
      "Thumbnail URL": {
        type: "url",
        url: "https://secure.notion-static.com/temporary.jpg",
      },
    },
  });

  assert.deepEqual(post.fields.imageUrl.value, [
    "https://prod-files-secure.s3.us-west-2.amazonaws.com/signed",
    "https://prod-files-secure.s3.us-west-2.amazonaws.com/signed",
  ]);
  assert.equal(post.assets.length, 0);
  assert.equal(post.qualification.qualified, false);
  assert.equal(post.qualification.skipped, 2);
});

test("files preserve stable and temporary candidates with unique rejection counts", () => {
  const temporary =
    "https://prod-files-secure.s3.us-west-2.amazonaws.com/notion-signed";
  const post = simplifyPostPage({
    id: POST_ID,
    properties: {
      Images: {
        type: "files",
        files: [
          {
            type: "external",
            external: { url: "https://assets.example.com/stable.png" },
          },
          {
            type: "file",
            file: { url: temporary },
          },
        ],
      },
      "Image URL": {
        type: "url",
        url: temporary,
      },
      "Thumbnail URL": {
        type: "url",
        url: "https://secure.notion-static.com/other-temporary.jpg",
      },
    },
  });

  assert.deepEqual(post.assets.map((asset) => asset.url), [
    "https://assets.example.com/stable.png",
  ]);
  assert.equal(post.qualification.skipped, 2);
});

function destinationSchema() {
  return {
    Name: { type: "title", title: {} },
    "Asset Type": {
      type: "select",
      select: {
        options: [{ name: "Image" }, { name: "Video" }, { name: "Cover" }],
      },
    },
    "Asset Status": {
      type: "status",
      status: {
        options: [{ name: "Captured" }, { name: "Uploaded to Cloudflare" }],
      },
    },
    "Storage Status": {
      type: "select",
      select: {
        options: [{ name: "In Notion" }, { name: "Uploaded to Cloudflare" }],
      },
    },
    "Cloudflare URL": { type: "url", url: {} },
    "Cloudflare Path": { type: "rich_text", rich_text: {} },
    Filename: { type: "rich_text", rich_text: {} },
    Format: {
      type: "select",
      select: {
        options: [{ name: "JPG" }, { name: "PNG" }, { name: "MP4" }],
      },
    },
    "Canonical Label": { type: "rich_text", rich_text: {} },
    "Product Lane": {
      type: "select",
      select: { options: [{ name: "Rednote post" }] },
    },
    "Series / Campaign": { type: "rich_text", rich_text: {} },
    Notes: { type: "rich_text", rich_text: {} },
    "Source Post": { type: "relation", relation: {} },
    Platform: {
      type: "select",
      select: { options: [{ name: "Instagram" }] },
    },
    "Needs media": { type: "checkbox", checkbox: {} },
  };
}

function notionResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function notionMediaRow(id, cloudflareUrl, sourcePostIds) {
  return {
    id,
    url: `https://www.notion.so/${id}`,
    properties: {
      "Cloudflare URL": { type: "url", url: cloudflareUrl },
      "Source Post": {
        type: "relation",
        relation: sourcePostIds.map((postId) => ({ id: postId })),
        has_more: false,
      },
    },
  };
}

function mediaResponse(bytes, contentType) {
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength),
    },
  });
}

function canonicalUrlForBytes(bytes, directory, extension) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  return `${CANONICAL_R2_ORIGIN}/${directory}/sha256/${hash.slice(
    0,
    2
  )}/${hash.slice(2, 4)}/${hash}.${extension}`;
}

function isoBaseMedia(brand) {
  const bytes = new Uint8Array(24);
  bytes.set([0, 0, 0, 24], 0);
  bytes.set(new TextEncoder().encode("ftyp"), 4);
  bytes.set(new TextEncoder().encode(brand), 8);
  bytes.set(new TextEncoder().encode(brand), 16);
  return bytes;
}
