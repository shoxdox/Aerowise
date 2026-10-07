import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

// The street map's tiles: one PMTiles file the operator installs on the server
// (docs/engineering/MAP.md), served from this origin with HTTP range requests, so the
// browser never asks a third-party map service for anything. MAP_TILES_FILE is its path.
// Outside production the synthetic test fixture is used when nothing is set.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FILE_NAME = "basemap.pmtiles";
/** A browser reads a PMTiles file a directory or a tile at a time; nothing it needs is near this big. */
const MAX_RANGE = 16 * 1024 * 1024;

function tilesPath(): string | null {
  const configured = process.env.MAP_TILES_FILE?.trim();
  if (configured) return configured;
  return process.env.NODE_ENV === "production" ? null : join(process.cwd(), "e2e/fixtures/map-fixture.pmtiles");
}

const notFound = () => new Response("No street map is installed on this server.", { status: 404, headers: { "content-type": "text/plain", "cache-control": "no-store" } });

async function serve(req: Request, file: string, method: "GET" | "HEAD") {
  if (file !== FILE_NAME) return notFound();
  const path = tilesPath();
  if (!path) return notFound();
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return notFound();

  const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    "content-type": "application/vnd.pmtiles",
    "accept-ranges": "bytes",
    etag,
    // Replacing the file changes its etag, and the map reader starts over when it sees a new one.
    "cache-control": "public, max-age=3600",
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

  const range = req.headers.get("range");
  if (!range) {
    headers["content-length"] = String(info.size);
    if (method === "HEAD") return new Response(null, { status: 200, headers });
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { status: 200, headers });
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start = m?.[1] ? Number(m[1]) : NaN;
  let end = m?.[2] ? Number(m[2]) : NaN;
  if (m && !m[1] && m[2]) {
    // The last N bytes.
    start = Math.max(0, info.size - Number(m[2]));
    end = info.size - 1;
  } else if (Number.isNaN(end) || end >= info.size) {
    end = info.size - 1;
  }
  if (!m || Number.isNaN(start) || start > end || start >= info.size || end - start + 1 > MAX_RANGE) {
    return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${info.size}` } });
  }
  const length = end - start + 1;
  headers["content-range"] = `bytes ${start}-${end}/${info.size}`;
  headers["content-length"] = String(length);
  if (method === "HEAD") return new Response(null, { status: 206, headers });
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return new Response(buf.subarray(0, bytesRead), { status: 206, headers });
  } finally {
    await fh.close();
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
  return serve(req, (await params).file, "GET");
}

export async function HEAD(req: Request, { params }: { params: Promise<{ file: string }> }) {
  return serve(req, (await params).file, "HEAD");
}
