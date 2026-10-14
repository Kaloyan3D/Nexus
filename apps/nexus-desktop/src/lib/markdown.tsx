import type { ReactNode } from "react";

/**
 * Deliberately small, HTML-free markdown subset: fenced code blocks, inline
 * code, bold, paragraphs and line breaks. Everything is emitted as React text
 * nodes, so untrusted content can never become markup, links or scripts.
 * An unterminated fence is treated as code to the end of the text.
 */

interface Block {
  type: "text" | "code";
  lang: string;
  body: string;
}

export function splitBlocks(src: string): Block[] {
  const out: Block[] = [];
  const lines = src.split("\n");
  let buf: string[] = [];
  let inCode = false;
  let lang = "";
  const flush = (type: Block["type"]) => {
    if (buf.length || type === "code") out.push({ type, lang, body: buf.join("\n") });
    buf = [];
  };
  for (const line of lines) {
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      if (inCode) {
        flush("code");
        inCode = false;
        lang = "";
      } else {
        flush("text");
        inCode = true;
        lang = (fence[1] ?? "").trim().slice(0, 20);
      }
    } else {
      buf.push(line);
    }
  }
  flush(inCode ? "code" : "text");
  return out.filter((b) => b.type === "code" || b.body.trim().length > 0);
}

function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0;
  let i = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) nodes.push(<code key={`${keyBase}-${i++}`}>{tok.slice(1, -1)}</code>);
    else nodes.push(<strong key={`${keyBase}-${i++}`}>{tok.slice(2, -2)}</strong>);
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function MarkdownLite({ text }: { text: string }) {
  const blocks = splitBlocks(text);
  return (
    <div className="nv-md">
      {blocks.map((b, bi) =>
        b.type === "code" ? (
          <pre key={bi} className="nv-md__code" tabIndex={0}>
            {b.lang && <span className="nv-md__lang">{b.lang}</span>}
            <code>{b.body}</code>
          </pre>
        ) : (
          <div key={bi} className="nv-md__text">
            {b.body.split(/\n{2,}/).map((para, pi) => (
              <p key={pi}>
                {para.split("\n").map((ln, li) => (
                  <span key={li}>
                    {li > 0 && <br />}
                    {inline(ln, `${bi}-${pi}-${li}`)}
                  </span>
                ))}
              </p>
            ))}
          </div>
        ),
      )}
    </div>
  );
}
