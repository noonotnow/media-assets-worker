const NOTION_VERSION = "2022-06-28";

const DEFAULT_MEDIA_ASSET_PROPS = {
  assetType: "Image",
  assetStatus: "Captured",
  storageStatus: "In Notion",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    try {
      assertConfig(env);

      if (url.pathname === "/health") {
        return jsonResponse({ ok: true, service: "media-assets-worker" });
      }

      if (url.pathname === "/test" && request.method === "GET") {
        await assertAuthorized(request, env);
        const result = await createMediaAsset(env, {
          name: "Worker test asset",
          notes: "Created by Cloudflare Worker test endpoint.",
        });

        return jsonResponse({ ok: true, result });
      }

      if (url.pathname === "/media-assets" && request.method === "POST") {
        await assertAuthorized(request, env);
        const input = await safeJson(request);
        const result = await createMediaAsset(env, input);
        return jsonResponse({ ok: true, result });
      }

      return jsonResponse(
        {
          ok: false,
          error: "Not found. Try GET /health, GET /test, or POST /media-assets.",
        },
        404
      );
    } catch (error) {
      return jsonResponse(
        {
          ok: false,
          error: error.message,
          details: error.details ?? undefined,
        },
        error.status ?? 500
      );
    }
  },
};

function assertConfig(env) {
  const missing = [];
  if (!env.NOTION_TOKEN) missing.push("NOTION_TOKEN");
  if (!env.WORKER_API_KEY) missing.push("WORKER_API_KEY");
  if (!env.MEDIA_ASSETS_DATABASE_ID) missing.push("MEDIA_ASSETS_DATABASE_ID");
  if (!env.POSTS_DATABASE_ID) missing.push("POSTS_DATABASE_ID");

  if (missing.length) {
    const error = new Error(`Missing required environment variables: ${missing.join(", ")}`);
    error.status = 500;
    throw error;
  }
}

async function assertAuthorized(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const [scheme, token] = authorization.split(" ");

  if (
    scheme !== "Bearer" ||
    !token ||
    !(await secureEqual(token, env.WORKER_API_KEY))
  ) {
    const error = new Error("Unauthorized.");
    error.status = 401;
    throw error;
  }
}

async function secureEqual(left, right) {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;

  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }

  return difference === 0;
}

async function createMediaAsset(env, input = {}) {
  const payload = buildMediaAssetPayload(env, input);
  const response = await notionFetch(env, "/v1/pages", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return {
    id: response.id,
    url: response.url,
    properties: response.properties,
  };
}

function buildMediaAssetPayload(env, input) {
  const name = cleanString(input.name) || "Untitled media asset";
  const notes = cleanString(input.notes);
  const series = cleanString(input.series || input.seriesCampaign);
  const canonicalLabel = cleanString(input.canonicalLabel);
  const filename = cleanString(input.filename);
  const cloudflarePath = cleanString(input.cloudflarePath);
  const cloudflareUrl = cleanString(input.cloudflareUrl);
  const format = cleanString(input.format);
  const productLane = cleanString(input.productLane);
  const textStatus = cleanString(input.textStatus);

  const assetType = cleanString(input.assetType) || DEFAULT_MEDIA_ASSET_PROPS.assetType;
  const assetStatus = cleanString(input.assetStatus) || DEFAULT_MEDIA_ASSET_PROPS.assetStatus;
  const storageStatus =
    cleanString(input.storageStatus) || DEFAULT_MEDIA_ASSET_PROPS.storageStatus;

  const properties = {
    Name: title(name),
    "Asset Type": select(assetType),
    "Asset Status": status(assetStatus),
    "Storage Status": select(storageStatus),
    "Captured Date": date(input.capturedDate || new Date().toISOString()),
  };

  if (notes) properties.Notes = richText(notes);
  if (series) properties["Series / Campaign"] = richText(series);
  if (canonicalLabel) properties["Canonical Label"] = richText(canonicalLabel);
  if (filename) properties.Filename = richText(filename);
  if (cloudflarePath) properties["Cloudflare Path"] = richText(cloudflarePath);
  if (cloudflareUrl) properties["Cloudflare URL"] = { url: cloudflareUrl };
  if (format) properties.Format = select(format);
  if (productLane) properties["Product Lane"] = select(productLane);
  if (textStatus) properties["Text Status"] = select(textStatus);
  if (typeof input.commercialUseCandidate === "boolean") {
    properties["Commercial Use Candidate"] = {
      checkbox: input.commercialUseCandidate,
    };
  }

  return {
    parent: { database_id: env.MEDIA_ASSETS_DATABASE_ID },
    properties,
  };
}

async function notionFetch(env, path, init = {}) {
  const response = await fetch(`https://api.notion.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
      ...(init.headers || {}),
    },
  });

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(data.message || "Notion API request failed.");
    error.status = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

async function safeJson(request) {
  const text = await request.text();
  if (!text.trim()) return {};

  try {
    return JSON.parse(text);
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.status = 400;
    throw error;
  }
}

function cleanString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function title(content) {
  return { title: [{ text: { content } }] };
}

function richText(content) {
  return { rich_text: [{ text: { content } }] };
}

function select(name) {
  return { select: { name } };
}

function status(name) {
  return { status: { name } };
}

function date(start) {
  return { date: { start } };
}

function jsonResponse(data, statusCode = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
