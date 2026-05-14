"use client";

export type PendingAttachment =
  | {
      id: string;
      status: "uploading";
      previewUrl: string;
      file: File;
    }
  | {
      id: string;
      status: "ready";
      previewUrl: string;
      gatewayPath: string;
      mimeType: string;
      originalName: string;
    }
  | {
      id: string;
      status: "error";
      previewUrl: string;
      reason: string;
    };

type AttachmentStripProps = {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
};

export default function AttachmentStrip({
  attachments,
  onRemove,
}: AttachmentStripProps) {
  if (attachments.length === 0) {
    return null;
  }
  return (
    <div
      className="cdx-attachment-strip"
      data-testid="composer-attachment-strip"
      role="list"
    >
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className={`cdx-attachment-thumb cdx-attachment-thumb--${attachment.status}`}
          data-testid="composer-attachment-thumb"
          data-attachment-id={attachment.id}
          data-attachment-status={attachment.status}
          role="listitem"
        >
          <img
            src={attachment.previewUrl}
            alt={
              attachment.status === "ready"
                ? attachment.originalName
                : "pending attachment"
            }
            className="cdx-attachment-thumb-image"
          />
          {attachment.status === "uploading" ? (
            <span
              className="cdx-attachment-thumb-overlay"
              data-testid="composer-attachment-uploading"
              aria-label="Uploading"
            >
              …
            </span>
          ) : null}
          {attachment.status === "error" ? (
            <span
              className="cdx-attachment-thumb-overlay cdx-attachment-thumb-overlay--error"
              data-testid="composer-attachment-error"
              title={attachment.reason}
              aria-label={`Upload failed: ${attachment.reason}`}
            >
              !
            </span>
          ) : null}
          <button
            type="button"
            className="cdx-attachment-thumb-remove"
            data-testid="composer-attachment-remove"
            onClick={() => onRemove(attachment.id)}
            aria-label="Remove attachment"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
