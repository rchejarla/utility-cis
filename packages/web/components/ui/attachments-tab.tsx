"use client";

import { useState, useEffect, useRef } from "react";
import type { AttachmentEntityType } from "@utility-cis/shared";
import { apiClient, API_URL } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";

interface Attachment {
  id: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  description?: string | null;
  createdAt: string;
  uploadedBy: string;
}

interface AttachmentsTabProps {
  /** Must match packages/shared AttachmentEntityType — TypeScript enforces it. */
  entityType: AttachmentEntityType;
  entityId: string;
  showForm?: boolean;
  onShowFormChange?: (show: boolean) => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const btnBase: React.CSSProperties = {
  padding: "6px 14px",
  fontSize: "12px",
  fontWeight: 500,
  borderRadius: "var(--radius)",
  cursor: "pointer",
  fontFamily: "inherit",
  border: "none",
};

export function AttachmentsTab({ entityType, entityId, showForm: showFormProp, onShowFormChange }: AttachmentsTabProps) {
  const { toast } = useToast();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showUploadLocal, setShowUploadLocal] = useState(false);
  const showUpload = showFormProp ?? showUploadLocal;
  const setShowUpload = (v: boolean) => { setShowUploadLocal(v); onShowFormChange?.(v); };
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [description, setDescription] = useState("");
  const [uploading, setUploading] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadAttachments = async () => {
    setLoading(true);
    try {
      const data = await apiClient.get<Attachment[]>("/api/v1/attachments", {
        entityType,
        entityId,
      });
      setAttachments(data);
    } catch (err: any) {
      toast(err.message || "Failed to load attachments", "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAttachments();
  }, [entityType, entityId]);

  const handleUpload = async () => {
    if (!selectedFile) return;
    setUploading(true);
    try {
      const formData = new FormData();
      // Text fields MUST come before the file — @fastify/multipart only reads fields before the file part
      formData.append("entityType", entityType);
      formData.append("entityId", entityId);
      if (description) formData.append("description", description);
      formData.append("file", selectedFile);

      await apiClient.upload<Attachment>("/api/v1/attachments", formData);
      toast("File uploaded successfully", "success");
      setShowUpload(false);
      setSelectedFile(null);
      setDescription("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      await loadAttachments();
    } catch (err: any) {
      toast(err.message || "Failed to upload file", "error");
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeleting(true);
    try {
      await apiClient.delete(`/api/v1/attachments/${id}`);
      toast("Attachment deleted", "success");
      setDeleteConfirmId(null);
      await loadAttachments();
    } catch (err: any) {
      toast(err.message || "Failed to delete attachment", "error");
    } finally {
      setDeleting(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    padding: "6px 10px",
    fontSize: "13px",
    background: "var(--bg-deep)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    color: "var(--text-primary)",
    fontFamily: "inherit",
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
  };

  return (
    <div>
      {/* Upload form */}
      {showUpload && (
        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "16px 20px",
            marginBottom: "16px",
          }}
        >
          <div
            style={{
              fontSize: "11px",
              fontWeight: 600,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              marginBottom: "12px",
            }}
          >
            Upload Attachment
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <div>
              <label style={{ display: "block", fontSize: "12px", color: "var(--text-muted)", marginBottom: "4px" }}>
                File <span style={{ color: "#f87171" }}>*</span>
              </label>
              <input
                ref={fileInputRef}
                type="file"
                style={inputStyle}
                onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "12px", color: "var(--text-muted)", marginBottom: "4px" }}>
                Description (optional)
              </label>
              <input
                type="text"
                style={inputStyle}
                value={description}
                placeholder="Brief description of this file..."
                onChange={(e) => setDescription(e.target.value)}
                maxLength={500}
              />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "4px" }}>
              <button
                onClick={() => {
                  setShowUpload(false);
                  setSelectedFile(null);
                  setDescription("");
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
                style={{ ...btnBase, background: "transparent", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
              >
                Cancel
              </button>
              <button
                onClick={handleUpload}
                disabled={!selectedFile || uploading}
                style={{
                  ...btnBase,
                  background: "var(--accent-primary)",
                  color: "#fff",
                  opacity: !selectedFile || uploading ? 0.6 : 1,
                  cursor: !selectedFile || uploading ? "not-allowed" : "pointer",
                }}
              >
                {uploading ? "Uploading..." : "Upload"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Attachments table */}
      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          overflow: "hidden",
        }}
      >
        {loading ? (
          <div style={{ padding: "32px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>
            Loading attachments...
          </div>
        ) : attachments.length === 0 ? (
          <div style={{ padding: "40px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>
            No attachments yet. Click &quot;+ Upload&quot; to add one.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--bg-elevated)" }}>
                {["File Name", "Type", "Size", "Description", "Uploaded", ""].map((h) => (
                  <th
                    key={h}
                    style={{
                      padding: "8px 14px",
                      textAlign: "left",
                      fontSize: "11px",
                      fontWeight: 600,
                      color: "var(--text-muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      borderBottom: "1px solid var(--border)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {attachments.map((att, i) => (
                <tr
                  key={att.id}
                  style={{
                    borderBottom: i < attachments.length - 1 ? "1px solid var(--border-subtle, var(--border))" : undefined,
                  }}
                >
                  {/* File Name — clickable to download */}
                  <td style={{ padding: "10px 14px", fontSize: "13px" }}>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        try {
                          const headers = await apiClient.getAuthHeadersOnly();
                          const res = await fetch(`${API_URL}/api/v1/attachments/${att.id}/download`, { headers });
                          if (!res.ok) throw new Error("Download failed");
                          const blob = await res.blob();
                          const url = window.URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = att.fileName;
                          a.click();
                          window.URL.revokeObjectURL(url);
                        } catch (err) {
                          toast("Failed to download file", "error");
                        }
                      }}
                      style={{
                        background: "none",
                        border: "none",
                        color: "var(--accent-primary)",
                        textDecoration: "none",
                        fontWeight: 500,
                        cursor: "pointer",
                        fontFamily: "inherit",
                        fontSize: "13px",
                        padding: 0,
                      }}
                      onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.textDecoration = "underline")}
                      onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.textDecoration = "none")}
                    >
                      {att.fileName}
                    </button>
                  </td>
                  {/* Type */}
                  <td style={{ padding: "10px 14px", fontSize: "12px", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                    {att.fileType}
                  </td>
                  {/* Size */}
                  <td style={{ padding: "10px 14px", fontSize: "12px", color: "var(--text-secondary)", whiteSpace: "nowrap", fontFamily: "monospace" }}>
                    {formatFileSize(att.fileSize)}
                  </td>
                  {/* Description */}
                  <td style={{ padding: "10px 14px", fontSize: "12px", color: "var(--text-secondary)", maxWidth: "200px" }}>
                    {att.description ?? <span style={{ color: "var(--text-muted)" }}>—</span>}
                  </td>
                  {/* Uploaded date */}
                  <td style={{ padding: "10px 14px", fontSize: "12px", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                    {new Date(att.createdAt).toLocaleDateString()}
                  </td>
                  {/* Delete */}
                  <td style={{ padding: "10px 14px", textAlign: "right", whiteSpace: "nowrap" }}>
                    <button
                      onClick={() => setDeleteConfirmId(att.id)}
                      style={{
                        ...btnBase,
                        padding: "4px 10px",
                        background: "transparent",
                        border: "1px solid rgba(239,68,68,0.4)",
                        color: "#f87171",
                        fontSize: "11px",
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Delete confirmation modal */}
      {deleteConfirmId && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
          }}
        >
          <div
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "24px",
              maxWidth: "400px",
              width: "100%",
            }}
          >
            <div style={{ fontSize: "16px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "8px" }}>
              Delete Attachment
            </div>
            <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "20px", lineHeight: 1.5 }}>
              Are you sure you want to permanently delete this attachment? This cannot be undone.
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button
                onClick={() => setDeleteConfirmId(null)}
                style={{ ...btnBase, background: "transparent", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteConfirmId)}
                disabled={deleting}
                style={{
                  ...btnBase,
                  background: "#ef4444",
                  color: "#fff",
                  opacity: deleting ? 0.7 : 1,
                  cursor: deleting ? "not-allowed" : "pointer",
                }}
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
