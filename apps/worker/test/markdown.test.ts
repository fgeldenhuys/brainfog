import { describe, expect, it } from "vitest";
import { escapeHtml, markdownToHtml } from "../src/markdown";

describe("Markdown Renderer", () => {
  describe("escapeHtml", () => {
    it("escapes HTML entities", () => {
      expect(escapeHtml("<script>alert('xss')</script>")).toEqual(
        "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;",
      );
      expect(escapeHtml('double "quotes"')).toEqual("double &quot;quotes&quot;");
      expect(escapeHtml("&")).toEqual("&amp;");
    });
  });

  describe("isSafeUrl", () => {
    it("renders safe links", () => {
      const result = markdownToHtml("[Google](https://google.com)");
      expect(result).toContain('<a href="https://google.com">Google</a>');
    });

    it("renders mailto links", () => {
      const result = markdownToHtml("[Email](mailto:test@example.com)");
      expect(result).toContain('<a href="mailto:test@example.com">Email</a>');
    });

    it("renders relative links", () => {
      const result = markdownToHtml("[Home](/app)");
      expect(result).toContain('<a href="/app">Home</a>');
    });

    it("escapes unsafe javascript URLs", () => {
      const result = markdownToHtml("[Click](javascript:alert('xss'))");
      expect(result).toContain("javascript:alert");
      // Should be escaped, not turned into a link
      expect(result).not.toContain('<a href="javascript');
    });

    it("escapes data URLs", () => {
      const result = markdownToHtml("[Image](data:text/html,<script>alert(1)</script>)");
      expect(result).not.toContain('<a href="data:');
    });
  });

  describe("headings", () => {
    it("renders h1", () => {
      expect(markdownToHtml("# Heading 1")).toEqual("<h1>Heading 1</h1>");
    });

    it("renders h2", () => {
      expect(markdownToHtml("## Heading 2")).toEqual("<h2>Heading 2</h2>");
    });

    it("renders h6 max", () => {
      expect(markdownToHtml("####### Too many hashes")).toContain("<h6>");
    });
  });

  describe("emphasis", () => {
    it("renders bold", () => {
      expect(markdownToHtml("This is **bold** text")).toContain("<strong>bold</strong>");
    });

    it("renders italic", () => {
      expect(markdownToHtml("This is *italic* text")).toContain("<em>italic</em>");
    });

    it("renders code", () => {
      expect(markdownToHtml("Use `const x = 1;` in code")).toContain("<code>const x = 1;</code>");
    });
  });

  describe("block quotes", () => {
    it("renders blockquote", () => {
      expect(markdownToHtml("> A quote")).toContain("<blockquote>");
    });

    it("renders multiline blockquote", () => {
      const md = "> Line 1\n> Line 2";
      const html = markdownToHtml(md);
      expect(html).toContain("<blockquote>");
      expect(html).toContain("Line 1");
      expect(html).toContain("Line 2");
    });
  });

  describe("code blocks", () => {
    it("renders fenced code block", () => {
      const md = "```\nconst x = 1;\n```";
      const html = markdownToHtml(md);
      expect(html).toContain("<pre><code>");
      expect(html).toContain("const x = 1;");
    });

    it("escapes HTML in code blocks", () => {
      const md = "```\n<script>alert('xss')</script>\n```";
      const html = markdownToHtml(md);
      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toContain("<script>");
    });
  });

  describe("lists", () => {
    it("renders unordered list", () => {
      const md = "* Item 1\n* Item 2\n* Item 3";
      const html = markdownToHtml(md);
      expect(html).toContain("<ul>");
      expect(html).toContain("<li>Item 1</li>");
      expect(html).toContain("<li>Item 2</li>");
    });

    it("renders ordered list", () => {
      const md = "1. First\n2. Second\n3. Third";
      const html = markdownToHtml(md);
      expect(html).toContain("<ol>");
      expect(html).toContain("<li>First</li>");
    });
  });

  describe("horizontal rules", () => {
    it("renders hr", () => {
      expect(markdownToHtml("---")).toContain("<hr/>");
      expect(markdownToHtml("===")).toContain("<hr/>");
    });
  });

  describe("combined document", () => {
    it("renders complex markdown safely", () => {
      const md = `# Title

This is a paragraph with **bold** and *italic*.

## Section

> A blockquote with [a link](https://example.com)

- List item 1
- List item 2

\`\`\`
code block
\`\`\`

Dangerous content: [Click here](javascript:alert('xss'))`;

      const html = markdownToHtml(md);

      // Safe content should be rendered
      expect(html).toContain("<h1>Title</h1>");
      expect(html).toContain("<strong>bold</strong>");
      expect(html).toContain("<em>italic</em>");
      expect(html).toContain("<blockquote>");
      expect(html).toContain('<a href="https://example.com">');
      expect(html).toContain("<ul>");
      expect(html).toContain("<pre><code>");

      // Dangerous content should be escaped or not rendered as a link
      expect(html).not.toContain("<script>");
      // The text will appear escaped, but not as an href attribute
      expect(html).not.toContain('href="javascript:');
    });
  });
});
