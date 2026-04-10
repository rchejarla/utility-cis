import { prisma } from "../lib/prisma.js";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const UPLOAD_DIR = path.resolve(process.cwd(), "../../uploads");
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB — must match app.ts multipart limit
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/**
 * Resolve a storagePath filename to an absolute path, asserting the result
 * is inside UPLOAD_DIR. Throws on any traversal attempt.
 */
function safeResolveStoragePath(storagePath: string): string {
  // Reject anything that smells like a path — we only store plain filenames.
  if (
    typeof storagePath !== "string" ||
    storagePath.length === 0 ||
    storagePath.includes("/") ||
    storagePath.includes("\\") ||
    storagePath.includes("\0") ||
    storagePath === "." ||
    storagePath === ".." ||
    storagePath.startsWith(".")
  ) {
    throw Object.assign(new Error("Invalid storage path"), { statusCode: 400 });
  }
  const resolved = path.resolve(UPLOAD_DIR, storagePath);
  const rel = path.relative(UPLOAD_DIR, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw Object.assign(new Error("Storage path escapes upload dir"), {
      statusCode: 400,
    });
  }
  return resolved;
}

export async function listAttachments(utilityId: string, entityType: string, entityId: string) {
  return prisma.attachment.findMany({
    where: { utilityId, entityType, entityId },
    orderBy: { createdAt: "desc" },
  });
}

export async function uploadAttachment(
  utilityId: string,
  actorId: string,
  entityType: string,
  entityId: string,
  fileName: string,
  fileType: string,
  fileBuffer: Buffer,
  description?: string
) {
  if (fileBuffer.length === 0) {
    throw Object.assign(new Error("Empty file"), { statusCode: 400 });
  }
  if (fileBuffer.length > MAX_FILE_SIZE) {
    throw Object.assign(new Error("File too large"), { statusCode: 413 });
  }
  if (!ALLOWED_MIME_TYPES.has(fileType)) {
    throw Object.assign(
      new Error(`Unsupported file type: ${fileType}`),
      { statusCode: 415, code: "UNSUPPORTED_MEDIA_TYPE" }
    );
  }

  // Generate a storage name that is NEVER derived from user input.
  // Keep the extension only after stripping any path separators.
  const rawExt = path.extname(fileName).replace(/[^a-zA-Z0-9.]/g, "");
  const ext = rawExt.length > 1 && rawExt.length <= 10 ? rawExt : "";
  const storedName = `${crypto.randomUUID()}${ext}`;
  const absolutePath = safeResolveStoragePath(storedName);

  fs.writeFileSync(absolutePath, fileBuffer);

  return prisma.attachment.create({
    data: {
      utilityId,
      entityType,
      entityId,
      fileName,
      fileType,
      fileSize: fileBuffer.length,
      storagePath: storedName, // Store just the filename, not full path
      uploadedBy: actorId,
      description,
    },
  });
}

export async function getAttachmentFile(id: string, utilityId: string) {
  const attachment = await prisma.attachment.findUniqueOrThrow({
    where: { id, utilityId },
  });

  const filePath = safeResolveStoragePath(attachment.storagePath);
  if (!fs.existsSync(filePath)) {
    throw Object.assign(new Error("File not found"), { statusCode: 404 });
  }

  return {
    attachment,
    buffer: fs.readFileSync(filePath),
  };
}

export async function deleteAttachment(id: string, utilityId: string) {
  const attachment = await prisma.attachment.findUniqueOrThrow({
    where: { id, utilityId },
  });

  // Delete file from disk (traversal-safe)
  try {
    const filePath = safeResolveStoragePath(attachment.storagePath);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Corrupt/unsafe storagePath — fall through and delete the DB record anyway.
  }

  await prisma.attachment.delete({ where: { id } });
  return attachment;
}
