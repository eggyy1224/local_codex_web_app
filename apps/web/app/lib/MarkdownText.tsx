"use client";

import { memo, type ReactElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type MarkdownTextProps = {
  text: string;
  /**
   * Optional class added to the wrapping element. The component already adds
   * `cdx-md` so global styles apply consistently across desktop + mobile.
   */
  className?: string;
};

function MarkdownTextInner({ text, className }: MarkdownTextProps): ReactElement {
  const composed = className ? `cdx-md ${className}` : "cdx-md";
  return (
    <div className={composed}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Skip raw HTML so untrusted assistant output cannot inject script /
        // style / iframe etc. react-markdown disallows it by default at v9
        // but the explicit flag documents the intent.
        skipHtml
        components={{
          // External links open in a new tab; same-origin / relative links keep
          // the normal target so internal anchors still work.
          a({ href, children, ...rest }) {
            const isExternal = typeof href === "string" && /^https?:\/\//i.test(href);
            return (
              <a
                href={href}
                {...rest}
                {...(isExternal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export const MarkdownText = memo(MarkdownTextInner);
