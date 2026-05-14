import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import AttachmentStrip, {
  type PendingAttachment,
} from "../app/threads/[id]/AttachmentStrip";

function uploading(id: string): PendingAttachment {
  return {
    id,
    status: "uploading",
    previewUrl: `blob:${id}`,
    file: new File(["x"], `${id}.png`, { type: "image/png" }),
  };
}

function ready(id: string): PendingAttachment {
  return {
    id,
    status: "ready",
    previewUrl: `blob:${id}`,
    gatewayPath: `/tmp/${id}.png`,
    mimeType: "image/png",
    originalName: `${id}.png`,
  };
}

function errored(id: string, reason: string): PendingAttachment {
  return { id, status: "error", previewUrl: `blob:${id}`, reason };
}

describe("AttachmentStrip", () => {
  it("renders nothing when empty", () => {
    const { container } = render(
      <AttachmentStrip attachments={[]} onRemove={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders one thumb per attachment with the correct status", () => {
    render(
      <AttachmentStrip
        attachments={[uploading("a"), ready("b"), errored("c", "oops")]}
        onRemove={vi.fn()}
      />,
    );
    const thumbs = screen.getAllByTestId("composer-attachment-thumb");
    expect(thumbs).toHaveLength(3);
    expect(thumbs[0]).toHaveAttribute("data-attachment-status", "uploading");
    expect(thumbs[1]).toHaveAttribute("data-attachment-status", "ready");
    expect(thumbs[2]).toHaveAttribute("data-attachment-status", "error");
    expect(screen.getByTestId("composer-attachment-uploading")).toBeInTheDocument();
    expect(screen.getByTestId("composer-attachment-error")).toBeInTheDocument();
  });

  it("calls onRemove with the attachment id when the × button is clicked", () => {
    const onRemove = vi.fn();
    render(
      <AttachmentStrip
        attachments={[ready("alpha"), ready("beta")]}
        onRemove={onRemove}
      />,
    );
    const removeButtons = screen.getAllByTestId("composer-attachment-remove");
    fireEvent.click(removeButtons[1]!);
    expect(onRemove).toHaveBeenCalledWith("beta");
  });

  it("uses originalName as alt text for ready attachments", () => {
    render(<AttachmentStrip attachments={[ready("hello")]} onRemove={vi.fn()} />);
    expect(screen.getByAltText("hello.png")).toBeInTheDocument();
  });
});
