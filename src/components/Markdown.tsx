import {
  Children,
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Options as ReactMarkdownOptions } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import {
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  Maximize2,
  Minimize2,
  WrapText,
} from "lucide-react";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import markdown from "highlight.js/lib/languages/markdown";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import yaml from "highlight.js/lib/languages/yaml";

let registered = false;
function ensureHljs() {
  if (registered) return;
  registered = true;
  hljs.registerLanguage("javascript", javascript);
  hljs.registerLanguage("js", javascript);
  hljs.registerLanguage("typescript", typescript);
  hljs.registerLanguage("ts", typescript);
  hljs.registerLanguage("tsx", typescript);
  hljs.registerLanguage("jsx", javascript);
  hljs.registerLanguage("json", json);
  hljs.registerLanguage("css", css);
  hljs.registerLanguage("html", xml);
  hljs.registerLanguage("xml", xml);
  hljs.registerLanguage("bash", bash);
  hljs.registerLanguage("sh", bash);
  hljs.registerLanguage("shell", bash);
  hljs.registerLanguage("python", python);
  hljs.registerLanguage("py", python);
  hljs.registerLanguage("rust", rust);
  hljs.registerLanguage("rs", rust);
  hljs.registerLanguage("sql", sql);
  hljs.registerLanguage("md", markdown);
  hljs.registerLanguage("markdown", markdown);
  hljs.registerLanguage("go", go);
  hljs.registerLanguage("java", java);
  hljs.registerLanguage("c", c);
  hljs.registerLanguage("cpp", cpp);
  hljs.registerLanguage("yaml", yaml);
  hljs.registerLanguage("yml", yaml);
}

type Props = {
  content: string;
  streaming?: boolean;
};

/** While tokens stream, only re-parse markdown every N ms / significant growth. */
const STREAM_MD_MIN_MS = 100;
const STREAM_MD_MIN_CHARS = 64;

const remarkPlugins = [remarkGfm];
const rehypePlugins = [
  rehypeRaw,
  [
    rehypeSanitize,
    {
      ...defaultSchema,
      tagNames: [...(defaultSchema.tagNames ?? []), "details", "summary"],
    },
  ],
] satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;

export const Markdown = memo(function Markdown({ content, streaming }: Props) {
  const [renderContent, setRenderContent] = useState(content);
  const lastFlushRef = useRef({ t: 0, len: 0, text: content });
  const pendingRef = useRef(content);
  const timerRef = useRef(0);

  useEffect(() => {
    if (!streaming) {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = 0;
      }
      lastFlushRef.current = {
        t: Date.now(),
        len: content.length,
        text: content,
      };
      setRenderContent(content);
      return;
    }

    pendingRef.current = content;
    const now = Date.now();
    const prev = lastFlushRef.current;
    const grew = content.length - prev.len;
    const due =
      now - prev.t >= STREAM_MD_MIN_MS || grew >= STREAM_MD_MIN_CHARS;
    if (due) {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = 0;
      }
      lastFlushRef.current = { t: now, len: content.length, text: content };
      setRenderContent(content);
      return;
    }
    // Keep a single pending timer — do not clear it on every token.
    if (timerRef.current) return;
    const wait = Math.max(16, STREAM_MD_MIN_MS - (now - prev.t));
    timerRef.current = window.setTimeout(() => {
      timerRef.current = 0;
      const latest = pendingRef.current;
      lastFlushRef.current = {
        t: Date.now(),
        len: latest.length,
        text: latest,
      };
      setRenderContent(latest);
    }, wait);
  }, [content, streaming]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = 0;
      }
    };
  }, []);

  const mdComponents = useMemo(
    () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      code({ node: _node, className, children, ...props }: any) {
        const text = String(children).replace(/\n$/, "");
        const match = /language-(\w+)/.exec(className || "");
        const isBlock = Boolean(match) || text.includes("\n");

        if (!isBlock) {
          return (
            <code className="chat-md__inline-code" {...props}>
              {children}
            </code>
          );
        }

        const lang = match?.[1] ?? "text";
        return (
          <CodeBlock language={lang} code={text} streaming={streaming}>
            {children}
          </CodeBlock>
        );
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      a({ node: _node, href, children }: any) {
        const safe = sanitizeHref(href);
        if (!safe) {
          return <span className="chat-md__bad-link">{children}</span>;
        }
        return (
          <a
            className="chat-md__external-link"
            href={safe}
            target="_blank"
            rel="noreferrer noopener"
          >
            <span>{children}</span>
            <ExternalLink size={11} strokeWidth={1.8} aria-hidden />
          </a>
        );
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      table({ node: _node, children, ...props }: any) {
        return <MarkdownTable {...props}>{children}</MarkdownTable>;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      details({ node: _node, children, open, ...props }: any) {
        return (
          <MarkdownDetails open={Boolean(open)} {...props}>
            {children}
          </MarkdownDetails>
        );
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      input({ node: _node, type, ...props }: any) {
        return <input type={type} {...props} readOnly={type === "checkbox"} />;
      },
    }),
    [streaming],
  );

  if (!content) return null;
  const body = streaming ? renderContent : content;

  return (
    <div className={`chat-md${streaming ? " is-streaming" : ""}`}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={mdComponents}
      >
        {body}
      </ReactMarkdown>
      {streaming ? <span className="chat-md__caret" aria-hidden /> : null}
    </div>
  );
});

function MarkdownDetails({
  children,
  open,
  ...props
}: React.ComponentProps<"details">) {
  const childNodes = Children.toArray(children);
  const summaryIndex = childNodes.findIndex(
    (child) => isValidElement(child) && child.type === "summary",
  );
  const summaryNode = summaryIndex >= 0 ? childNodes[summaryIndex] : null;
  const summary =
    isValidElement<{ children?: ReactNode }>(summaryNode) &&
    summaryNode.props.children
      ? summaryNode.props.children
      : "Details";
  const content = childNodes.filter((_, index) => index !== summaryIndex);

  return (
    <details className="chat-md__details" open={open} {...props}>
      <summary>
        <ChevronRight size={15} strokeWidth={1.8} aria-hidden />
        <span>{summary}</span>
      </summary>
      <div className="chat-md__details-body">{content}</div>
    </details>
  );
}

function MarkdownTable({ children, ...props }: React.ComponentProps<"table">) {
  const tableRef = useRef<HTMLTableElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const copyTable = useCallback(async (format: "markdown" | "csv") => {
    const table = tableRef.current;
    if (!table) return;
    const rows = [...table.rows].map((row) =>
      [...row.cells].map((cell) => cell.innerText.trim()),
    );
    if (rows.length === 0) return;
    const text =
      format === "csv" ? serializeTableCsv(rows) : serializeTableMarkdown(rows);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      return;
    }
    setMenuOpen(false);
  }, []);

  return (
    <div className="chat-md__table" data-expanded={expanded ? "true" : "false"}>
      <div className="chat-md__table-scroll">
        <table ref={tableRef} {...props}>
          {children}
        </table>
      </div>
      <div className="chat-md__table-footer">
        <button
          type="button"
          aria-label={expanded ? "Collapse table cells" : "Expand table cells"}
          aria-pressed={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? (
            <Minimize2 size={12} aria-hidden />
          ) : (
            <Maximize2 size={12} aria-hidden />
          )}
        </button>
        <div className="chat-md__table-copy" ref={menuRef}>
          <button
            type="button"
            aria-label={copied ? "Copied" : "Copy table"}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            {copied ? (
              <Check size={12} aria-hidden />
            ) : (
              <Copy size={12} aria-hidden />
            )}
          </button>
          {menuOpen ? (
            <div className="chat-md__table-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => void copyTable("markdown")}
              >
                Copy as Markdown
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => void copyTable("csv")}
              >
                Copy as CSV
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function serializeTableMarkdown(rows: string[][]): string {
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) =>
    Array.from({ length: width }, (_, index) =>
      (row[index] ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>"),
    ),
  );
  const header = normalized[0] ?? [];
  const divider = Array.from({ length: width }, () => "---");
  return [header, divider, ...normalized.slice(1)]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");
}

function serializeTableCsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","),
    )
    .join("\n");
}

function CodeBlock({
  language,
  code,
  streaming,
}: {
  language: string;
  code: string;
  streaming?: boolean;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);

  const html = useMemo(() => {
    ensureHljs();
    // While tokens stream, skip highlight (expensive) — plain escape is enough.
    if (streaming) return escapeHtml(code);
    try {
      if (language && language !== "text" && hljs.getLanguage(language)) {
        return hljs.highlight(code, { language }).value;
      }
      // Unknown / missing lang: skip highlightAuto (scans every registered grammar).
      return escapeHtml(code);
    } catch {
      return escapeHtml(code);
    }
  }, [code, language, streaming]);

  return (
    <div className="chat-md__code" data-wrap={wrap ? "true" : "false"}>
      <div className="chat-md__code-head">
        <span className="chat-md__code-lang">{language}</span>
        <div
          className="chat-md__code-actions"
          role="toolbar"
          aria-label="Code block actions"
        >
          <button
            type="button"
            className="chat-md__code-btn"
            aria-label={wrap ? "Disable line wrap" : "Wrap lines"}
            aria-pressed={wrap}
            onClick={() => setWrap((v) => !v)}
          >
            <WrapText size={12} aria-hidden />
          </button>
          <button
            type="button"
            className="chat-md__code-btn"
            aria-label={copied ? "Copied" : "Copy code"}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(code);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              } catch {
                /* ignore */
              }
            }}
          >
            {copied ? (
              <Check size={12} aria-hidden />
            ) : (
              <Copy size={12} aria-hidden />
            )}
          </button>
        </div>
      </div>
      <pre>
        <code
          className={`hljs language-${language}`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </pre>
    </div>
  );
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Allow only http(s) and mailto - reject javascript:/data:/file: etc. */
function sanitizeHref(href: string | undefined): string | null {
  if (!href) return null;
  const raw = href.trim();
  if (!raw || raw.startsWith("#")) return null;
  try {
    const url = new URL(raw, "https://invalid.local");
    const scheme = url.protocol.toLowerCase();
    if (scheme === "http:" || scheme === "https:" || scheme === "mailto:") {
      return raw;
    }
  } catch {
    /* ignore */
  }
  return null;
}
