import { createHash, randomUUID } from "node:crypto";
import { open, lstat, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;

function validateFilename(filename: string): void {
  if (!filename || filename === "." || filename === ".." || path.basename(filename) !== filename || filename.includes("/") || filename.includes("\\") || filename.includes("\0")) {
    throw new Error("Projection filename must be a single safe path component");
  }
}

function validateHash(expectedSha256: string): void {
  if (!SHA256.test(expectedSha256)) throw new Error("Expected SHA-256 must be 64 lowercase hexadecimal characters");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function resolveDirectory(directory: string): Promise<string> {
  const resolved = path.resolve(directory);
  const stat = await lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Projection directory must be a real directory");
  const canonical = await realpath(resolved);
  if (canonical !== resolved) throw new Error("Projection directory resolves through a link");
  return canonical;
}

async function destinationState(destination: string): Promise<"missing" | "regular" | "unsafe"> {
  try {
    const stat = await lstat(destination);
    // On Windows, lstat marks symlinks and other reparse points as symbolic links.
    return stat.isFile() && !stat.isSymbolicLink() ? "regular" : "unsafe";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

/** Verify that a file projection exactly matches the trusted SQLite SHA-256. Missing or
 * stale regular files return false; links and non-file destinations fail closed. */
export async function verifyReportProjection(directory: string, filename: string, expectedSha256: string): Promise<boolean> {
  validateFilename(filename);
  validateHash(expectedSha256);
  const canonicalDirectory = await resolveDirectory(directory);
  const destination = path.join(canonicalDirectory, filename);
  const state = await destinationState(destination);
  if (state === "missing") return false;
  if (state !== "regular") throw new Error(`Unsafe projection destination: ${filename}`);
  try {
    return sha256(await readFile(destination)) === expectedSha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Materialize trusted SQLite-fixed UTF-8 bytes as a repairable file projection.
 * The temp file is unique and same-directory, opened with wx, flushed, renamed, and
 * verified by readback. This does not promise directory-entry durability after power loss. */
export async function materializeReportProjection(
  directory: string,
  filename: string,
  contentBytes: Uint8Array,
  expectedSha256: string,
): Promise<void> {
  validateFilename(filename);
  validateHash(expectedSha256);
  if (!(contentBytes instanceof Uint8Array)) throw new Error("Projection content must be bytes");
  if (sha256(contentBytes) !== expectedSha256) throw new Error("Projection bytes do not match the trusted SHA-256");

  const canonicalDirectory = await resolveDirectory(directory);
  const destination = path.join(canonicalDirectory, filename);
  const currentState = await destinationState(destination);
  if (currentState === "unsafe") throw new Error(`Unsafe projection destination: ${filename}`);
  if (currentState === "regular" && await verifyReportProjection(canonicalDirectory, filename, expectedSha256)) return;

  const temporary = path.join(canonicalDirectory, `.${filename}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contentBytes);
    await handle.sync();
    await handle.close();
    handle = undefined;

    // Recheck immediately before replacement so a changed destination link is not followed.
    const stateBeforeRename = await destinationState(destination);
    if (stateBeforeRename === "unsafe") throw new Error(`Unsafe projection destination: ${filename}`);
    await rename(temporary, destination);
    if (!await verifyReportProjection(canonicalDirectory, filename, expectedSha256)) {
      throw new Error(`Projection readback hash mismatch: ${filename}`);
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
