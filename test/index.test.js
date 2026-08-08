import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFromPostMediaAssetPayload,
  qualifyPostFields,
  simplifyPostPage,
} from "../src/index.js";

const POST_ID = "11111111-2222-4333-8444-555555555555";

test("simplifies Post aliases and prefers the image URL", () => {
  const post = simplifyPostPage({
    id: POST_ID,
    url: `https://www.notion.so/${POST_ID}`,
    created_time: "2026-08-08T00:00:00.000Z",
    last_edited_time: "2026-08-08T01:00:00.000Z",
    properties: {
      Headline: {
        type: "title",
        title: [{ plain_text: "Launch image" }],
      },
      "Images URL": {
        type: "url",
        url: "https://assets.example.com/posts/launch.png",
      },
      Thumbnail: {
        type: "files",
        files: [
          { external: { url: "https://assets.example.com/thumbs/launch.jpg" } },
        ],
      },
      Platform: {
        type: "select",
        select: { name: "Instagram" },
      },
    },
  });

  assert.equal(post.fields.headline.value, "Launch image");
  assert.equal(post.fields.platform.value, "Instagram");
  assert.deepEqual(post.qualification, {
    qualified: true,
    cloudflareUrl: "https://assets.example.com/posts/launch.png",
    cloudflarePath: "/posts/launch.png",
    sourceProperty: "Images URL",
  });
});

test("falls back to a valid thumbnail and rejects non-http values", () => {
  const qualified = qualifyPostFields({
    imageUrl: { propertyName: "Image URL", value: "r2://bucket/image.png" },
    thumbnail: {
      propertyName: "Thumbnail URL",
      value: "https://assets.example.com/thumb.png",
    },
  });
  const unqualified = qualifyPostFields({
    imageUrl: { propertyName: "Image URL", value: "not a URL" },
    thumbnail: { propertyName: "Thumbnail", value: "ftp://example.com/a.png" },
  });

  assert.equal(qualified.cloudflareUrl, "https://assets.example.com/thumb.png");
  assert.equal(qualified.sourceProperty, "Thumbnail URL");
  assert.equal(unqualified.qualified, false);
  assert.equal(unqualified.cloudflareUrl, null);
});

test("does not qualify temporary Notion-hosted file URLs", () => {
  const post = simplifyPostPage({
    id: POST_ID,
    url: `https://www.notion.so/${POST_ID}`,
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
        ],
      },
    },
  });

  assert.deepEqual(post.fields.imageUrl.value, []);
  assert.equal(post.qualification.qualified, false);
});

test("builds only schema-compatible Media Assets properties", () => {
  const post = {
    id: POST_ID,
    url: `https://www.notion.so/${POST_ID}`,
    fields: {
      headline: { value: "Launch image" },
      imageUrl: { value: "https://assets.example.com/posts/launch.png" },
      thumbnail: null,
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
    qualification: {
      qualified: true,
      cloudflareUrl: "https://assets.example.com/posts/launch.png",
      cloudflarePath: "/posts/launch.png",
      sourceProperty: "Images URL",
    },
  };
  const schema = {
    Name: { type: "title", title: {} },
    "Asset Type": {
      type: "select",
      select: { options: [{ name: "Image" }] },
    },
    "Asset Status": {
      type: "status",
      status: { options: [{ name: "Captured" }] },
    },
    "Storage Status": {
      type: "select",
      select: { options: [{ name: "In Notion" }] },
    },
    "Cloudflare URL": { type: "url", url: {} },
    "Cloudflare Path": { type: "rich_text", rich_text: {} },
    "Series / Campaign": { type: "rich_text", rich_text: {} },
    Notes: { type: "rich_text", rich_text: {} },
    "Source Post": { type: "relation", relation: {} },
    Platform: {
      type: "select",
      select: { options: [{ name: "TikTok" }] },
    },
    "Needs media": { type: "checkbox", checkbox: {} },
  };

  const payload = buildFromPostMediaAssetPayload(
    { MEDIA_ASSETS_DATA_SOURCE_ID: "media-assets-source" },
    post,
    schema
  );

  assert.deepEqual(payload.properties["Source Post"], {
    relation: [{ id: POST_ID }],
  });
  assert.equal(
    payload.properties["Cloudflare URL"].url,
    "https://assets.example.com/posts/launch.png"
  );
  assert.equal(payload.properties.Platform, undefined);
  assert.deepEqual(payload.properties["Needs media"], { checkbox: true });
  assert.match(
    payload.properties.Notes.rich_text[0].text.content,
    /Requirements: Square crop/
  );
});

test("omits Source Post when the destination property is not a relation", () => {
  const payload = buildFromPostMediaAssetPayload(
    { MEDIA_ASSETS_DATA_SOURCE_ID: "media-assets-source" },
    {
      id: POST_ID,
      url: null,
      fields: {
        headline: { value: "Image" },
        imageUrl: null,
        thumbnail: null,
      },
      qualification: {
        qualified: true,
        cloudflareUrl: "https://assets.example.com/image.png",
        cloudflarePath: "/image.png",
        sourceProperty: "Image URL",
      },
    },
    {
      Name: { type: "title", title: {} },
      "Cloudflare URL": { type: "url", url: {} },
      "Source Post": { type: "rich_text", rich_text: {} },
    }
  );

  assert.equal(payload.properties["Source Post"], undefined);
});
