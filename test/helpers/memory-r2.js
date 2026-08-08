export class MemoryR2Bucket {
  constructor() {
    this.objects = new Map();
    this.multipartUploads = [];
    this.deletedKeys = [];
    this.putKeys = [];
    this.failUploadPartAt = null;
    this.failMultipartForKey = null;
  }

  seed(key, bytes, options = {}) {
    this.objects.set(
      key,
      storedObject(bytes, options.httpMetadata, options.customMetadata)
    );
  }

  async head(key) {
    const object = this.objects.get(key);
    return object ? objectMetadata(key, object) : null;
  }

  async get(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      ...objectMetadata(key, object),
      body: new Blob([object.bytes]).stream(),
      bodyUsed: false,
      arrayBuffer: async () => object.bytes.slice().buffer,
    };
  }

  async put(key, value, options = {}) {
    const bytes = await readBytes(value);
    this.putKeys.push(key);
    this.objects.set(
      key,
      storedObject(bytes, options.httpMetadata, options.customMetadata)
    );
    return objectMetadata(key, this.objects.get(key));
  }

  async delete(key) {
    const keys = Array.isArray(key) ? key : [key];
    this.deletedKeys.push(...keys);
    for (const item of keys) this.objects.delete(item);
  }

  async list(options = {}) {
    const prefix = options.prefix || "";
    const objects = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, options.limit || 1000)
      .map(([key, object]) => objectMetadata(key, object));
    return {
      objects,
      truncated: false,
      delimitedPrefixes: [],
    };
  }

  async createMultipartUpload(key, options = {}) {
    const record = {
      key,
      parts: new Map(),
      aborted: false,
      completed: false,
      options,
    };
    this.multipartUploads.push(record);
    const bucket = this;

    return {
      key,
      uploadId: `mock-upload-${this.multipartUploads.length}`,
      async uploadPart(partNumber, value) {
        if (
          bucket.failUploadPartAt === partNumber &&
          (!bucket.failMultipartForKey ||
            bucket.failMultipartForKey === key)
        ) {
          throw new Error("mock upload failure");
        }
        const bytes = await readBytes(value);
        record.parts.set(partNumber, bytes);
        return { partNumber, etag: `etag-${partNumber}` };
      },
      async complete(parts) {
        const chunks = parts.map(({ partNumber }) => record.parts.get(partNumber));
        const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        record.completed = true;
        bucket.objects.set(
          key,
          storedObject(
            bytes,
            options.httpMetadata,
            options.customMetadata
          )
        );
        return objectMetadata(key, bucket.objects.get(key));
      },
      async abort() {
        record.aborted = true;
        record.parts.clear();
      },
    };
  }

  stagingKeys() {
    return [...this.objects.keys()].filter((key) =>
      key.startsWith("imports/staging/")
    );
  }
}

async function readBytes(value) {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    );
  }
  return new Uint8Array(await new Response(value).arrayBuffer());
}

function storedObject(bytes, httpMetadata = {}, customMetadata = {}) {
  return {
    bytes: bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes),
    httpMetadata: { ...httpMetadata },
    customMetadata: { ...customMetadata },
  };
}

function objectMetadata(key, object) {
  return {
    key,
    size: object.bytes.byteLength,
    etag: `etag-${key}`,
    httpEtag: `"etag-${key}"`,
    uploaded: new Date("2026-08-08T00:00:00.000Z"),
    httpMetadata: { ...object.httpMetadata },
    customMetadata: { ...object.customMetadata },
  };
}
