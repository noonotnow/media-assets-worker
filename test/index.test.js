import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  buildExistingMediaAssetFilter,
  buildFromPostMediaAssetPayload,
  buildPostAssets,
  extractStableAssetUrls,
  qualifyPostFields,
  simplifyPostPage,
} from "../src/index.js";

const POST_ID = "3068d902-271f-810e-82e8-f878238d58dd";

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
      value: "https://pub-example.r2.dev/launch-thumb.jpg",
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
  const thumbnail = buildPostAssets({
    headline: post.fields.headline,
    imageUrl: null,
    thumbnail: {
      propertyName: "Thumbnail URL",
      value: "https://pub-example.r2.dev/launch.jpg",
    },
  }).assets[0];
  const schema = destinationSchema();

  const payload = buildFromPostMediaAssetPayload(
    { MEDIA_ASSETS_DATA_SOURCE_ID: "media-assets-source" },
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

test("dedupe filter always includes exact URL and optionally Source Post", () => {
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
  assert.deepEqual(withoutRelation, {
    property: "Cloudflare URL",
    url: { equals: "https://assets.example.com/a.png" },
  });
  assert.equal(withoutUrl, null);
});

test("POST /from-post returns aggregate results for existing and created URLs", async () => {
  const originalFetch = globalThis.fetch;
  const queryBodies = [];
  const createBodies = [];
  const existingRows = new Map([
    [
      "https://assets.example.com/a.png",
      {
        id: "existing-row",
        url: "https://www.notion.so/existing-row",
      },
    ],
  ]);

  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
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
      const assetUrl = body.filter.and[1].url.equals;
      return notionResponse({
        results: existingRows.has(assetUrl) ? [existingRows.get(assetUrl)] : [],
      });
    }
    if (path === "/v1/pages" && init.method === "POST") {
      const body = JSON.parse(init.body);
      createBodies.push(body);
      const page = {
        id: "created-row",
        url: "https://www.notion.so/created-row",
      };
      existingRows.set(body.properties["Cloudflare URL"].url, page);
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
        }
      );
    const response = await callFromPost();
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(
      {
        ok: body.ok,
        totalAssets: body.totalAssets,
        created: body.created,
        existing: body.existing,
        skipped: body.skipped,
      },
      { ok: true, totalAssets: 2, created: 1, existing: 1, skipped: 0 }
    );
    assert.deepEqual(
      body.results.map((result) => ({
        url: result.url,
        created: result.created,
        id: result.id,
        sourceKind: result.sourceKind,
        sourceIndex: result.sourceIndex,
      })),
      [
        {
          url: "https://assets.example.com/a.png",
          created: false,
          id: "existing-row",
          sourceKind: "image",
          sourceIndex: 1,
        },
        {
          url: "https://assets.example.com/b.mov",
          created: true,
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
        existing: repeatBody.existing,
      },
      { totalAssets: 2, created: 0, existing: 2 }
    );
    assert.deepEqual(
      repeatBody.results.map((result) => result.created),
      [false, false]
    );
    assert.equal(queryBodies.length, 4);
    assert.equal(
      queryBodies[1].filter.and[1].url.equals,
      "https://assets.example.com/b.mov"
    );
    assert.equal(createBodies.length, 1);
    assert.deepEqual(createBodies[0].properties["Asset Type"], {
      select: { name: "Video" },
    });
    assert.equal(createBodies[0].properties.Format, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
