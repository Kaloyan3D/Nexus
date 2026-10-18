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

type TextBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "quote"; lines: string[] }
  | { kind: "rule" }
  | { kind: "para"; lines: string[] };

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

/** Block structure of one text run: headings, lists, tables, quotes, rules, paragraphs. */
export function parseTextBlocks(body: string): TextBlock[] {
  const lines = body.split("\n");
  const out: TextBlock[] = [];
  let i = 0;
  const para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push({ kind: "para", lines: [...para] });
    para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flushPara();
      out.push({ kind: "heading", level: h[1]!.length, text: h[2]! });
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      out.push({ kind: "rule" });
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1]!)) {
      flushPara();
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!));
      out.push({ kind: "table", head, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushPara();
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) q.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      out.push({ kind: "quote", lines: q });
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const ordered = /\d/.test(li[1]!);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (m) {
          items.push(m[2]!);
          i++;
        } else if (/^\s{2,}\S/.test(lines[i]!) && items.length) {
          items[items.length - 1] += " " + lines[i]!.trim(); // wrapped item text
          i++;
        } else break;
      }
      out.push({ kind: "list", ordered, items });
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return out;
}

function Lines({ lines, k }: { lines: string[]; k: string }) {
  return (
    <>
      {lines.map((ln, li) => (
        <span key={li}>
          {li > 0 && <br />}
          {inline(ln, `${k}-${li}`)}
        </span>
      ))}
    </>
  );
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
            {parseTextBlocks(b.body).map((t, ti) => {
              const k = `${bi}-${ti}`;
              switch (t.kind) {
                case "heading": {
                  const H = (`h${Math.min(6, t.level + 1)}`) as "h2";
                  return <H key={k} className="nv-md__h">{inline(t.text, k)}</H>;
                }
                case "rule":
                  return <hr key={k} />;
                case "list": {
                  const L = t.ordered ? "ol" : "ul";
                  return (
                    <L key={k}>
                      {t.items.map((it, ii) => (
                        <li key={ii}>{inline(it, `${k}-${ii}`)}</li>
                      ))}
                    </L>
                  );
                }
                case "table":
                  return (
                    <div key={k} className="nv-md__tablewrap">
                      <table className="nv-md__table">
                        <thead>
                          <tr>{t.head.map((c, ci) => <th key={ci}>{inline(c, `${k}-h${ci}`)}</th>)}</tr>
                        </thead>
                        <tbody>
                          {t.rows.map((r, ri) => (
                            <tr key={ri}>{r.map((c, ci) => <td key={ci}>{inline(c, `${k}-${ri}-${ci}`)}</td>)}</tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                case "quote":
                  return <blockquote key={k}><Lines lines={t.lines} k={k} /></blockquote>;
                default:
                  return <p key={k}><Lines lines={t.lines} k={k} /></p>;
              }
            })}
          </div>
        ),
      )}
    </div>
  );
}
