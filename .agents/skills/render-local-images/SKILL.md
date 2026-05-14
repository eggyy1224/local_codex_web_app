---
name: render-local-images
description: Render local image files directly in Codex replies. Use when the user asks to show, display, preview, render, or browse images from local paths, MCP image-library results, tieshan-images batches/searches, or generated asset folders.
---

# Render Local Images

Use this skill whenever the user wants images shown inside the conversation, especially for `tieshan-images`, `image_library`, generated batches, built-in image generation outputs, or local file paths.

## Goal

Display actual images inline in the reply with Markdown image syntax, instead of only describing paths or asking the user to open files.

## Workflow

1. Get candidate image records or paths.
   - For `tieshan-images` MCP, use tools such as `lib_list_batches`, `lib_batch_images`, `lib_search`, or `lib_similar_by_id`.
   - If MCP records return `rel_path`, resolve them against the project image root when obvious.
   - Common root for the Tieshan pseudo-photography library:
     `/Volumes/2024data/鐵山誌相關`

2. Verify the files exist before rendering.
   - Use `ls`, `file`, or `sips -g pixelWidth -g pixelHeight` for a small sample.
   - Do not use destructive operations.

3. Render images inline with Markdown:

   ```markdown
   ![short title](</absolute/path/with spaces/image.png>)
   ```

   Always wrap local paths in angle brackets when they contain spaces, Chinese characters, parentheses, plus signs, or other shell/Markdown-sensitive characters.

4. Keep captions compact.
   - Prefer labels like image id, variant code, batch, or title.
   - Do not paste long prompts unless the user asks.

5. If inline rendering fails or the UI cannot show local paths, make a fallback contact sheet in `/tmp` or another safe temp path, then render that sheet inline.

## Built-in Image Generation Pattern

When using Codex's built-in image generation tool, the tool may create the PNG
successfully but not surface it inline in the local web UI. If the user says the
generated image did not appear:

1. Locate the generated file under:

   ```text
   /Users/liweichen/.codex/generated_images/
   ```

   Prefer the exact directory reported by the tool/developer message. If no
   exact directory is known, list the newest image files by modification time.

2. Verify the file exists and is an image:

   ```sh
   file /Users/liweichen/.codex/generated_images/.../ig_....png
   ```

3. Render it inline with the absolute local path:

   ```markdown
   ![generated image](</Users/liweichen/.codex/generated_images/.../ig_....png>)
   ```

4. If that still does not render, make a temporary contact sheet or copy only a
   display copy to a safe preview location. Leave the original generated image
   in place.

## Tieshan Images Pattern

For latest batch preview:

1. Call `mcp__tieshan_images__lib_list_batches` with a small limit.
2. Pick the intended batch, usually the newest unless the user specified a theme/query.
3. Call `mcp__tieshan_images__lib_batch_images`.
4. Resolve each `rel_path` as:

   ```text
   /Volumes/2024data/鐵山誌相關/{rel_path}
   ```

5. Show 4-8 representative images inline.

Example reply shape:

```markdown
最新 batch `v229`，先貼 4 張：

![SW-01](</Volumes/2024data/鐵山誌相關/AI生成素材/偽攝影/.../SW-01_example.png>)

![SW-02](</Volumes/2024data/鐵山誌相關/AI生成素材/偽攝影/.../SW-02_example.png>)
```

## Safety Notes

- Do not move, rename, delete, or regenerate images just to display them.
- Do not write into production image folders for previews.
- If creating a contact sheet, write it to `/tmp` unless the user requests a saved artifact.
- If the user asks for curation actions such as winner/reject/hold, treat that as a separate explicit state-changing request.
