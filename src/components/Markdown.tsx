import { marked } from "marked";
import { useMemo } from "react";

marked.setOptions({ gfm: true, breaks: false });

/** Renders model-written or user-written markdown. Raw HTML is escaped. */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const escaped = text.replace(/<(?!\/?(details|summary)>)/g, "&lt;");
    return marked.parse(escaped, { async: false }) as string;
  }, [text]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
