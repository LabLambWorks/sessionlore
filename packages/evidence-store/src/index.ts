import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  link,
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  HashSchema,
  type IngestBatch,
  IngestBatchSchema,
} from "@sessionlore/contracts";

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeOnce(
  path: string,
  content: Uint8Array | string,
): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  try {
    // Publish a complete file without replacing a snapshot written by another process.
    await link(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await unlink(temporary);
  }
}

export class EvidenceStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  rawPath(sourceId: string): string {
    HashSchema.parse(sourceId);
    return join(this.root, "raw", sourceId);
  }

  private async verifyRaw(sourceId: string, size?: number): Promise<void> {
    const digest = createHash("sha256");
    let count = 0;
    for await (const value of createReadStream(this.rawPath(sourceId))) {
      const bytes = value as Buffer;
      count += bytes.length;
      digest.update(bytes);
    }
    if (
      digest.digest("hex") !== sourceId ||
      (size !== undefined && size !== count)
    )
      throw new Error("Stored raw snapshot failed its integrity check");
  }

  /** Capture the byte range present at discovery without buffering the entire file. */
  async captureFile(path: string) {
    const metadata = await stat(path);
    if (metadata.size > 2 * 1024 ** 3)
      throw new Error("Raw source exceeds the 2 GiB streaming snapshot limit.");
    const directory = join(this.root, "raw");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `${randomUUID()}.tmp`);
    const digest = createHash("sha256");
    let size = 0;
    try {
      if (metadata.size)
        await pipeline(
          createReadStream(path, { start: 0, end: metadata.size - 1 }),
          new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              size += chunk.length;
              digest.update(chunk);
              callback(null, chunk);
            },
          }),
          createWriteStream(temporary, { mode: 0o600, flags: "wx" }),
        );
      else await writeFile(temporary, "", { mode: 0o600, flag: "wx" });
      if (size !== metadata.size)
        throw new Error(
          "Input shrank during capture; retry after the source is stable.",
        );
      const sourceId = digest.digest("hex");
      try {
        await link(temporary, this.rawPath(sourceId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.verifyRaw(sourceId, size);
      }
      return {
        sourceId,
        path: this.rawPath(sourceId),
        rawSize: size,
        mtime: metadata.mtime.toISOString(),
      };
    } finally {
      await unlink(temporary).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }

  async saveBatch(batchInput: IngestBatch): Promise<boolean> {
    const batch = IngestBatchSchema.parse(batchInput);
    if (
      batch.events.some(
        (event) => event.payload_ref.source_id !== batch.source.source_id,
      )
    )
      throw new Error("Event points outside its source snapshot");
    await this.verifyRaw(batch.source.source_id, batch.source.size_bytes);
    return writeOnce(
      this.batchPath(batch.source.source_id, batch.source.adapter_version),
      `${JSON.stringify(batch, null, 2)}\n`,
    );
  }

  async loadBatch(
    sourceId: string,
    adapterVersion: string,
  ): Promise<IngestBatch> {
    const batch = IngestBatchSchema.parse(
      JSON.parse(
        await readFile(this.batchPath(sourceId, adapterVersion), "utf8"),
      ),
    );
    if (
      batch.source.source_id !== sourceId ||
      batch.source.adapter_version !== adapterVersion
    )
      throw new Error("Stored snapshot manifest failed its integrity check");
    await this.verifyRaw(sourceId, batch.source.size_bytes);
    return batch;
  }

  private batchPath(sourceId: string, adapterVersion: string): string {
    HashSchema.parse(sourceId);
    if (!/^[a-zA-Z0-9._-]+$/.test(adapterVersion))
      throw new Error("Invalid adapter version");
    return join(this.root, "snapshots", sourceId, `${adapterVersion}.json`);
  }

  async save(batchInput: IngestBatch, bytes: Buffer): Promise<boolean> {
    const batch = IngestBatchSchema.parse(batchInput);
    const sourceId = batch.source.source_id;
    if (hash(bytes) !== sourceId || bytes.length !== batch.source.size_bytes)
      throw new Error("Raw snapshot does not match its source manifest");
    if (batch.events.some((event) => event.payload_ref.source_id !== sourceId))
      throw new Error("Event points outside its source snapshot");
    const rawPath = join(this.root, "raw", sourceId);
    if (
      !(await writeOnce(rawPath, bytes)) &&
      hash(await readFile(rawPath)) !== sourceId
    ) {
      throw new Error("Stored raw snapshot failed its integrity check");
    }
    return writeOnce(
      this.batchPath(sourceId, batch.source.adapter_version),
      `${JSON.stringify(batch, null, 2)}\n`,
    );
  }

  async load(
    sourceId: string,
    adapterVersion: string,
  ): Promise<{ batch: IngestBatch; bytes: Buffer }> {
    const batch = IngestBatchSchema.parse(
      JSON.parse(
        await readFile(this.batchPath(sourceId, adapterVersion), "utf8"),
      ),
    );
    const bytes = await readFile(join(this.root, "raw", sourceId));
    if (
      batch.source.source_id !== sourceId ||
      batch.source.adapter_version !== adapterVersion ||
      hash(bytes) !== sourceId ||
      bytes.length !== batch.source.size_bytes
    ) {
      throw new Error("Stored raw snapshot failed its integrity check");
    }
    return { batch, bytes };
  }
}
