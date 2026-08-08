const NOTION_VERSION = "2025-09-03";
const SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;

const DEFAULT_MEDIA_ASSET_PROPS = {
  assetType: "Image",
  assetStatus: "Captured",
  storageStatus: "In Notion",
};

export const SOURCE_FIELD_ALIASES = Object.freeze({
  headline: ["Headline", "Title", "Name"],
  imageUrl: ["Images URL", "Image URL", "Images"],
  thumbnail: ["Thumbnail", "Thumbnail URL"],
  platform: ["Platform"],
  series: ["Series"],
  productionMode: ["Production Mode"],
  mediaSource: ["Media source", "Media Source"],
  campaignName: [
    "Campaign / event name",
    "Campaign / Event Name",
    "Campaign",
    "Event name",
  ],
  campaignNotes: [
    "Campaign notes / requirements",
    "Campaign Notes / Requirements",
  ],
  requirements: ["Requirements"],
  notes: ["Notes"],
  needsMedia: ["Needs media", "Needs Media"],
});

const DESTINATION_FIELD_ALIASES = Object.freeze({
  title: ["Name"],
  notes: ["Notes"],
  seriesCampaign: ["Series / Campaign"],
  cloudflareUrl: ["Cloudflare URL"],
  cloudflarePath: ["Cloudflare Path"],
  sourcePost: ["Source Post"],
  filename: ["Filename"],
  canonicalLabel: ["Canonical Label"],
  format: ["Format"],
  assetType: ["Asset Type"],
  assetStatus: ["Asset Status"],
  storageStatus: ["Storage Status"],
  capturedDate: ["Captured Date"],
  platform: ["Platform"],
  series: ["Series"],
  productionMode: ["Production Mode"],
  mediaSource: ["Media source", "Media Source"],
  campaignName: ["Campaign / event name", "Campaign / Event Name"],
  campaignNotes: [
    "Campaign notes / requirements",
    "Campaign Notes / Requirements",
  ],
  requirements: ["Requirements"],
  needsMedia: ["Needs media", "Needs Media"],
});

const mediaAssetsSchemaCache = new Map();

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

      const postRoute = url.pathname.match(/^\/post\/([^/]+)$/);
      if (postRoute && request.method === "GET") {
        await assertAuthorized(request, env);
        const postId = validatePostId(decodeURIComponent(postRoute[1]));
        const post = await getPost(env, postId);
        return jsonResponse({ ok: true, result: simplifyPostPage(post) });
      }

      if (url.pathname === "/from-post" && request.method === "POST") {
        await assertAuthorized(request, env);
        const input = await safeJson(request);
        const postId = validateFromPostInput(input);
        const result = await createMediaAssetFromPost(env, postId);
        return jsonResponse({ ok: true, ...result });
      }

      return jsonResponse(
        {
          ok: false,
          error:
            "Not found. Try GET /health, GET /test, GET /post/:id, POST /media-assets, or POST /from-post.",
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
  if (!env.MEDIA_ASSETS_DATA_SOURCE_ID) {
    missing.push("MEDIA_ASSETS_DATA_SOURCE_ID");
  }

  if (missing.length) {
    throw httpError(
      500,
      `Missing required environment variables: ${missing.join(", ")}`
    );
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
    throw httpError(401, "Unauthorized.");
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

async function getPost(env, postId) {
  return notionFetch(env, `/v1/pages/${postId}`);
}

async function createMediaAssetFromPost(env, postId) {
  const post = await getPost(env, postId);
  const simplifiedPost = simplifyPostPage(post);

  if (!simplifiedPost.qualification.qualified) {
    throw httpError(
      409,
      "Post does not qualify: no valid http(s) URL was found in an image URL or thumbnail property.",
      {
        checkedProperties: [
          ...SOURCE_FIELD_ALIASES.imageUrl,
          ...SOURCE_FIELD_ALIASES.thumbnail,
        ],
      }
    );
  }

  const schema = await getMediaAssetsSchema(env);
  const existing = await findExistingMediaAsset(env, schema, simplifiedPost);

  if (existing) {
    return {
      created: false,
      result: summarizeMediaAsset(existing),
    };
  }

  const payload = buildFromPostMediaAssetPayload(
    env,
    simplifiedPost,
    schema.properties || {}
  );
  const created = await notionFetch(env, "/v1/pages", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return {
    created: true,
    result: summarizeMediaAsset(created),
  };
}

async function getMediaAssetsSchema(env) {
  const cacheKey = env.MEDIA_ASSETS_DATA_SOURCE_ID;
  const cached = mediaAssetsSchemaCache.get(cacheKey);

  if (cached && Date.now() - cached.loadedAt < SCHEMA_CACHE_TTL_MS) {
    return cached.schema;
  }

  const schema = await notionFetch(
    env,
    `/v1/data_sources/${env.MEDIA_ASSETS_DATA_SOURCE_ID}`
  );
  mediaAssetsSchemaCache.set(cacheKey, { loadedAt: Date.now(), schema });
  return schema;
}

async function findExistingMediaAsset(env, schema, post) {
  const properties = schema.properties || {};
  const sourcePost = findSchemaProperty(
    properties,
    DESTINATION_FIELD_ALIASES.sourcePost,
    "relation"
  );
  let filter;

  if (sourcePost) {
    filter = {
      property: sourcePost.name,
      relation: { contains: post.id },
    };
  } else {
    const cloudflareUrl = findSchemaProperty(
      properties,
      DESTINATION_FIELD_ALIASES.cloudflareUrl,
      "url"
    );

    if (!cloudflareUrl) return null;

    filter = {
      property: cloudflareUrl.name,
      url: { equals: post.qualification.cloudflareUrl },
    };
  }

  const query = await notionFetch(
    env,
    `/v1/data_sources/${env.MEDIA_ASSETS_DATA_SOURCE_ID}/query`,
    {
      method: "POST",
      body: JSON.stringify({ filter, page_size: 1 }),
    }
  );

  return query.results?.[0] || null;
}

async function createMediaAsset(env, input = {}) {
  const payload = buildMediaAssetPayload(env, input);
  const response = await notionFetch(env, "/v1/pages", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return summarizeMediaAsset(response);
}

function summarizeMediaAsset(page) {
  return {
    id: page.id,
    url: page.url,
    properties: page.properties,
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

  const assetType =
    cleanString(input.assetType) || DEFAULT_MEDIA_ASSET_PROPS.assetType;
  const assetStatus =
    cleanString(input.assetStatus) || DEFAULT_MEDIA_ASSET_PROPS.assetStatus;
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
    parent: {
      type: "data_source_id",
      data_source_id: env.MEDIA_ASSETS_DATA_SOURCE_ID,
    },
    properties,
  };
}

export function buildFromPostMediaAssetPayload(
  env,
  post,
  destinationSchema
) {
  const properties = {};
  const fields = post.fields;
  const cloudflareUrl = post.qualification.cloudflareUrl;
  const cloudflarePath = post.qualification.cloudflarePath;
  const filename = filenameFromUrl(cloudflareUrl);
  const format = formatFromFilename(filename);
  const name =
    cleanString(fields.headline?.value) ||
    filename ||
    `Post ${post.id}`;
  const titleProperty =
    findSchemaProperty(
      destinationSchema,
      DESTINATION_FIELD_ALIASES.title,
      "title"
    ) || findFirstSchemaProperty(destinationSchema, "title");

  if (!titleProperty) {
    throw httpError(
      500,
      "Media Assets schema does not expose a title property."
    );
  }

  properties[titleProperty.name] = title(name);

  setCompatibleProperty(
    properties,
    destinationSchema,
    DESTINATION_FIELD_ALIASES.assetType,
    DEFAULT_MEDIA_ASSET_PROPS.assetType
  );
  setCompatibleProperty(
    properties,
    destinationSchema,
    DESTINATION_FIELD_ALIASES.assetStatus,
    DEFAULT_MEDIA_ASSET_PROPS.assetStatus
  );
  setCompatibleProperty(
    properties,
    destinationSchema,
    DESTINATION_FIELD_ALIASES.storageStatus,
    DEFAULT_MEDIA_ASSET_PROPS.storageStatus
  );
  setCompatibleProperty(
    properties,
    destinationSchema,
    DESTINATION_FIELD_ALIASES.capturedDate,
    new Date().toISOString()
  );
  setCompatibleProperty(
    properties,
    destinationSchema,
    DESTINATION_FIELD_ALIASES.cloudflareUrl,
    cloudflareUrl
  );
  setCompatibleProperty(
    properties,
    destinationSchema,
    DESTINATION_FIELD_ALIASES.cloudflarePath,
    cloudflarePath
  );
  setCompatibleProperty(
    properties,
    destinationSchema,
    DESTINATION_FIELD_ALIASES.filename,
    filename
  );
  setCompatibleProperty(
    properties,
    destinationSchema,
    DESTINATION_FIELD_ALIASES.format,
    format
  );
  setCompatibleProperty(
    properties,
    destinationSchema,
    DESTINATION_FIELD_ALIASES.canonicalLabel,
    cleanString(fields.headline?.value)
  );

  const seriesCampaign = uniqueTextValues([
    fields.series?.value,
    fields.campaignName?.value,
  ]).join(" / ");
  setCompatibleProperty(
    properties,
    destinationSchema,
    DESTINATION_FIELD_ALIASES.seriesCampaign,
    seriesCampaign
  );

  for (const fieldName of [
    "platform",
    "series",
    "productionMode",
    "mediaSource",
    "campaignName",
    "campaignNotes",
    "requirements",
    "needsMedia",
  ]) {
    setCompatibleProperty(
      properties,
      destinationSchema,
      DESTINATION_FIELD_ALIASES[fieldName],
      fields[fieldName]?.value
    );
  }

  const notes = buildPostContextNotes(post);
  setCompatibleProperty(
    properties,
    destinationSchema,
    DESTINATION_FIELD_ALIASES.notes,
    notes
  );

  const sourcePost = findSchemaProperty(
    destinationSchema,
    DESTINATION_FIELD_ALIASES.sourcePost,
    "relation"
  );
  if (sourcePost) {
    properties[sourcePost.name] = { relation: [{ id: post.id }] };
  }

  return {
    parent: {
      type: "data_source_id",
      data_source_id: env.MEDIA_ASSETS_DATA_SOURCE_ID,
    },
    properties,
  };
}

export function simplifyPostPage(page) {
  const properties = page.properties || {};
  const fields = {};

  for (const [fieldName, aliases] of Object.entries(SOURCE_FIELD_ALIASES)) {
    let match = findPageProperty(properties, aliases);
    if (!match && fieldName === "headline") {
      match = findFirstPageProperty(properties, "title");
    }

    fields[fieldName] = match
      ? {
          propertyName: match.name,
          type: match.property.type,
          value: propertyToSimpleValue(match.property),
        }
      : null;
  }

  const qualification = qualifyPostFields(fields);

  return {
    id: page.id,
    url: page.url,
    createdTime: page.created_time,
    lastEditedTime: page.last_edited_time,
    fields,
    qualification,
  };
}

export function qualifyPostFields(fields) {
  const imageUrl = firstHttpUrl(fields.imageUrl?.value);
  const thumbnailUrl = firstHttpUrl(fields.thumbnail?.value);
  const cloudflareUrl = imageUrl || thumbnailUrl || null;
  const source = imageUrl
    ? fields.imageUrl?.propertyName
    : thumbnailUrl
      ? fields.thumbnail?.propertyName
      : null;

  return {
    qualified: Boolean(cloudflareUrl),
    cloudflareUrl,
    cloudflarePath: cloudflareUrl
      ? cloudflarePathFromUrl(cloudflareUrl)
      : null,
    sourceProperty: source,
  };
}

function buildPostContextNotes(post) {
  const lines = [
    `Source Post: ${post.url || post.id}`,
    `Source Post ID: ${post.id}`,
  ];
  const labels = {
    headline: "Headline",
    platform: "Platform",
    series: "Series",
    productionMode: "Production Mode",
    mediaSource: "Media source",
    campaignName: "Campaign / event name",
    campaignNotes: "Campaign notes / requirements",
    requirements: "Requirements",
    notes: "Post notes",
    needsMedia: "Needs media",
    imageUrl: "Image URL",
    thumbnail: "Thumbnail",
  };

  for (const [fieldName, label] of Object.entries(labels)) {
    const value = displayValue(post.fields[fieldName]?.value);
    if (value) lines.push(`${label}: ${value}`);
  }

  return lines.join("\n");
}

function setCompatibleProperty(
  output,
  schema,
  aliases,
  value
) {
  if (!aliases || value === null || value === undefined || value === "") return;

  const match = findSchemaProperty(schema, aliases);
  if (!match) return;

  const encoded = encodePropertyValue(match.property, value);
  if (encoded) output[match.name] = encoded;
}

function encodePropertyValue(property, value) {
  switch (property.type) {
    case "title":
      return title(cleanString(value));
    case "rich_text":
      return richText(displayValue(value));
    case "url": {
      const url = firstHttpUrl(value);
      return url ? { url } : null;
    }
    case "select":
      return encodeSingleOption(property.select?.options, value, "select");
    case "status":
      return encodeSingleOption(property.status?.options, value, "status");
    case "multi_select": {
      const values = Array.isArray(value) ? value : [value];
      const options = values
        .map((item) => findExistingOption(property.multi_select?.options, item))
        .filter(Boolean)
        .map((name) => ({ name }));
      return options.length ? { multi_select: options } : null;
    }
    case "checkbox": {
      const checkbox = booleanValue(value);
      return checkbox === null ? null : { checkbox };
    }
    case "date":
      return typeof value === "string" && value ? date(value) : null;
    case "number": {
      const number = Number(value);
      return Number.isFinite(number) ? { number } : null;
    }
    default:
      return null;
  }
}

function encodeSingleOption(options, value, type) {
  const name = findExistingOption(options, value);
  return name ? { [type]: { name } } : null;
}

function findExistingOption(options = [], value) {
  const sought = cleanString(value).toLowerCase();
  if (!sought) return null;
  return (
    options.find((option) => option.name.toLowerCase() === sought)?.name || null
  );
}

function findSchemaProperty(schema, aliases, requiredType) {
  for (const alias of aliases) {
    const match = Object.entries(schema).find(
      ([name, property]) =>
        name.toLowerCase() === alias.toLowerCase() &&
        (!requiredType || property.type === requiredType)
    );
    if (match) return { name: match[0], property: match[1] };
  }
  return null;
}

function findFirstSchemaProperty(schema, type) {
  const match = Object.entries(schema).find(
    ([, property]) => property.type === type
  );
  return match ? { name: match[0], property: match[1] } : null;
}

function findPageProperty(properties, aliases) {
  for (const alias of aliases) {
    const match = Object.entries(properties).find(
      ([name]) => name.toLowerCase() === alias.toLowerCase()
    );
    if (match) return { name: match[0], property: match[1] };
  }
  return null;
}

function findFirstPageProperty(properties, type) {
  const match = Object.entries(properties).find(
    ([, property]) => property.type === type
  );
  return match ? { name: match[0], property: match[1] } : null;
}

function propertyToSimpleValue(property) {
  switch (property.type) {
    case "title":
    case "rich_text":
      return (property[property.type] || [])
        .map((item) => item.plain_text || item.text?.content || "")
        .join("");
    case "url":
    case "email":
    case "phone_number":
    case "number":
    case "checkbox":
      return property[property.type] ?? null;
    case "select":
    case "status":
      return property[property.type]?.name || null;
    case "multi_select":
      return (property.multi_select || []).map((item) => item.name);
    case "date":
      return property.date
        ? { start: property.date.start, end: property.date.end || null }
        : null;
    case "files":
      return (property.files || [])
        .map((file) => file.external?.url)
        .filter(Boolean);
    case "relation":
      return (property.relation || []).map((item) => item.id);
    case "people":
      return (property.people || []).map(
        (person) => person.name || person.person?.email || person.id
      );
    case "formula":
      return property.formula
        ? property.formula[property.formula.type] ?? null
        : null;
    case "rollup":
      return simplifyRollup(property.rollup);
    case "created_time":
    case "last_edited_time":
      return property[property.type] || null;
    default:
      return null;
  }
}

function simplifyRollup(rollup) {
  if (!rollup) return null;
  if (rollup.type === "array") {
    return rollup.array.map((item) => propertyToSimpleValue(item));
  }
  return rollup[rollup.type] ?? null;
}

function validateFromPostInput(input) {
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw httpError(400, "Request body must be a JSON object.");
  }
  return validatePostId(input.postId);
}

function validatePostId(value) {
  const postId = cleanString(value);
  const compact = postId.replaceAll("-", "");
  if (!/^[0-9a-fA-F]{32}$/.test(compact)) {
    throw httpError(400, "postId must be a valid Notion page UUID.");
  }
  return postId;
}

function firstHttpUrl(value) {
  const values = Array.isArray(value) ? value : [value];

  for (const candidate of values) {
    if (Array.isArray(candidate)) {
      const nested = firstHttpUrl(candidate);
      if (nested) return nested;
      continue;
    }

    const text = cleanString(candidate);
    if (!text) continue;

    try {
      const url = new URL(text);
      if (url.protocol === "http:" || url.protocol === "https:") return text;
    } catch {
      // Ignore malformed source values and continue to the next candidate.
    }
  }

  return null;
}

function cloudflarePathFromUrl(value) {
  try {
    return new URL(value).pathname || null;
  } catch {
    return null;
  }
}

function filenameFromUrl(value) {
  const pathname = cloudflarePathFromUrl(value);
  if (!pathname) return "";
  const filename = pathname.split("/").filter(Boolean).at(-1) || "";
  try {
    return decodeURIComponent(filename);
  } catch {
    return filename;
  }
}

function formatFromFilename(filename) {
  const extension = cleanString(filename).split(".").at(-1);
  if (!extension || extension === filename) return "";
  return extension.toUpperCase();
}

function uniqueTextValues(values) {
  const unique = new Set();
  for (const value of values) {
    const text = displayValue(value);
    if (text) unique.add(text);
  }
  return [...unique];
}

function displayValue(value) {
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join(", ");
  if (typeof value === "object") {
    if ("start" in value) {
      return value.end ? `${value.start} to ${value.end}` : cleanString(value.start);
    }
    return JSON.stringify(value);
  }
  return cleanString(value);
}

function booleanValue(value) {
  if (typeof value === "boolean") return value;
  const text = cleanString(value).toLowerCase();
  if (["yes", "true", "1"].includes(text)) return true;
  if (["no", "false", "0"].includes(text)) return false;
  return null;
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
    throw httpError(
      response.status,
      data.message || "Notion API request failed.",
      {
        code: data.code,
        status: response.status,
      }
    );
  }

  return data;
}

async function safeJson(request) {
  const text = await request.text();
  if (!text.trim()) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, "Request body must be valid JSON.");
  }
}

function httpError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  if (details) error.details = details;
  return error;
}

function cleanString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function title(content) {
  return { title: textFragments(content) };
}

function richText(content) {
  return { rich_text: textFragments(content) };
}

function textFragments(content) {
  const text = cleanString(content);
  const fragments = [];
  for (let index = 0; index < text.length; index += 2000) {
    fragments.push({ text: { content: text.slice(index, index + 2000) } });
  }
  return fragments;
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
