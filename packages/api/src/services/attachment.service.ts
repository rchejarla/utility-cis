import { prisma } from "../lib/prisma.js";
import * as fs from "fs";
import * as path from "path";

const UPLOAD_DIR = path.resolve(process.cwd(), "../../uploads");

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
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
  // Create a unique filename
  const ext = path.extname(fileName);
  const storedName = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
  const storagePath = path.join(UPLOAD_DIR, storedName);

  // Write file to disk
  fs.writeFileSync(storagePath, fileBuffer);

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

  const filePath = path.join(UPLOAD_DIR, attachment.storagePath);
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

  // Delete file from disk
  const filePath = path.join(UPLOAD_DIR, attachment.storagePath);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  // Delete record
  await prisma.attachment.delete({ where: { id } });
  return attachment;
}
