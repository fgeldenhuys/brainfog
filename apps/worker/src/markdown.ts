/**
 * Conservative Markdown-to-HTML renderer.
 * Supports: headings, paragraphs, emphasis/strong, inline code, code blocks,
 * blockquotes, lists (ordered/unordered), links, horizontal rules, tables.
 * All output is escaped; unsafe HTML and URLs are neutralized.
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isSafeUrl(url: string): boolean {
  try {
    // Allow https, http, mailto, or relative URLs starting with /
    if (url.startsWith("/") || url.startsWith("#")) return true;
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:";
  } catch {
    return false;
  }
}

function renderInline(text: string): string {
  let result = "";
  let i = 0;

  while (i < text.length) {
    // Bold (** **)
    if (text.substring(i, i + 2) === "**") {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) {
        result += `<strong>${escapeHtml(text.substring(i + 2, end))}</strong>`;
        i = end + 2;
        continue;
      }
    }

    // Italic (* *)
    if (text[i] === "*" && i + 1 < text.length && text[i + 1] !== "*") {
      const end = text.indexOf("*", i + 1);
      if (end !== -1 && text[end - 1] !== "\\") {
        result += `<em>${escapeHtml(text.substring(i + 1, end))}</em>`;
        i = end + 1;
        continue;
      }
    }

    // Inline code (backticks)
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        result += `<code>${escapeHtml(text.substring(i + 1, end))}</code>`;
        i = end + 1;
        continue;
      }
    }

    // Link [text](url)
    const linkMatch = text.substring(i).match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch?.[1] && linkMatch[2]) {
      const linkText = linkMatch[1];
      const url = linkMatch[2];
      if (isSafeUrl(url)) {
        result += `<a href="${escapeHtml(url)}">${escapeHtml(linkText)}</a>`;
      } else {
        result += escapeHtml(`[${linkText}](${url})`);
      }
      i += linkMatch[0].length;
      continue;
    }

    result += escapeHtml(text[i] || "");
    i++;
  }

  return result;
}

interface MarkdownBlock {
  type: "heading" | "paragraph" | "code" | "blockquote" | "list" | "table" | "hr";
  level?: number; // for headings
  content?: string; // for paragraph, code, blockquote
  items?: string[]; // for lists
  ordered?: boolean; // for lists
  rows?: Array<{ cells: string[] }>; // for tables
}

function parseBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line) {
      i++;
      continue;
    }
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) {
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(---|===)$/.test(trimmed)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // Headings
    const headingMatch = trimmed.match(/^(#+)\s+(.+)$/);
    if (headingMatch?.[1] && headingMatch[2]) {
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        content: headingMatch[2],
      });
      i++;
      continue;
    }

    // Code block (triple backticks)
    if (trimmed.startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length) {
        const currentLine = lines[i];
        if (!currentLine || currentLine.trim().startsWith("```")) break;
        codeLines.push(currentLine);
        i++;
      }
      if (i < lines.length) i++; // skip closing ```
      blocks.push({
        type: "code",
        content: codeLines.join("\n"),
      });
      continue;
    }

    // Blockquote
    if (trimmed.startsWith("> ")) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const currentLine = lines[i];
        if (!currentLine?.trim().startsWith("> ")) break;
        const quoted = currentLine.trim().substring(2);
        quoteLines.push(quoted);
        i++;
      }
      blocks.push({
        type: "blockquote",
        content: quoteLines.join("\n"),
      });
      continue;
    }

    // Lists (unordered)
    if (/^[*-]\s/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length) {
        const currentLine = lines[i];
        if (!currentLine || !/^[*-]\s/.test(currentLine.trim())) break;
        items.push(currentLine.trim().substring(2));
        i++;
      }
      blocks.push({
        type: "list",
        ordered: false,
        items,
      });
      continue;
    }

    // Lists (ordered)
    const orderedMatch = trimmed.match(/^\d+\.\s/);
    if (orderedMatch) {
      const items: string[] = [];
      while (i < lines.length) {
        const currentLine = lines[i];
        if (!currentLine || !/^\d+\.\s/.test(currentLine.trim())) break;
        const item = currentLine.trim().replace(/^\d+\.\s/, "");
        items.push(item);
        i++;
      }
      blocks.push({
        type: "list",
        ordered: true,
        items,
      });
      continue;
    }

    // Tables (simple markdown table)
    const nextLine = lines[i + 1];
    if (
      nextLine &&
      line.includes("|") &&
      nextLine.includes("|") &&
      /^\s*\|?[\s\-|:]+\|?\s*$/.test(nextLine)
    ) {
      const rows: Array<{ cells: string[] }> = [];
      // Header
      rows.push({
        cells: line
          .split("|")
          .map((c) => c.trim())
          .filter((c) => c),
      });
      i += 2; // skip separator
      // Body
      while (i < lines.length) {
        const currentLine = lines[i];
        if (!currentLine?.includes("|")) break;
        rows.push({
          cells: currentLine
            .split("|")
            .map((c) => c.trim())
            .filter((c) => c),
        });
        i++;
      }
      blocks.push({
        type: "table",
        rows,
      });
      continue;
    }

    // Paragraph (default)
    const paraLines: string[] = [line];
    i++;
    while (i < lines.length) {
      const currentLine = lines[i];
      if (!currentLine?.trim() || currentLine.match(/^(#+\s|```|>\s|[*-]\s|\d+\.\s)/)) {
        break;
      }
      paraLines.push(currentLine);
      i++;
    }
    blocks.push({
      type: "paragraph",
      content: paraLines.join(" ").trim(),
    });
  }

  return blocks;
}

export function markdownToHtml(markdown: string): string {
  const blocks = parseBlocks(markdown);
  let html = "";

  for (const block of blocks) {
    switch (block.type) {
      case "heading": {
        const level = Math.min(block.level ?? 1, 6);
        const tag = `h${level}`;
        html += `<${tag}>${escapeHtml(block.content ?? "")}</${tag}>`;
        break;
      }

      case "paragraph":
        html += `<p>${renderInline(block.content ?? "")}</p>`;
        break;

      case "code":
        html += `<pre><code>${escapeHtml(block.content ?? "")}</code></pre>`;
        break;

      case "blockquote":
        html += `<blockquote>${renderInline(block.content ?? "")}</blockquote>`;
        break;

      case "list": {
        const listTag = block.ordered ? "ol" : "ul";
        html += `<${listTag}>`;
        for (const item of block.items ?? []) {
          html += `<li>${renderInline(item)}</li>`;
        }
        html += `</${listTag}>`;
        break;
      }

      case "table": {
        html += "<table border='1' cellpadding='8'>";
        for (let idx = 0; idx < (block.rows?.length ?? 0); idx++) {
          const row = block.rows?.[idx];
          if (!row) continue;
          const isHeader = idx === 0;
          html += "<tr>";
          for (const cell of row.cells) {
            const cellTag = isHeader ? "th" : "td";
            html += `<${cellTag}>${renderInline(cell)}</${cellTag}>`;
          }
          html += "</tr>";
        }
        html += "</table>";
        break;
      }

      case "hr":
        html += "<hr/>";
        break;
    }
  }

  return html;
}
