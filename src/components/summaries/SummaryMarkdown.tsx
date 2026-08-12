import Markdown from "react-markdown";
import type { Components } from "react-markdown";

/**
 * Elements the summary is allowed to render. LLM output is untrusted (transcript content can steer
 * it), so `img` and `a` are excluded: an image would make the viewer's browser fetch an
 * attacker-controlled URL, and a link would offer an attacker-controlled navigation target. Anything
 * outside this list is unwrapped, so its text still shows.
 */
const SUMMARY_ALLOWED_ELEMENTS = ["p", "ul", "ol", "li", "strong", "em", "h2", "h3", "code"];

/**
 * Element map for the Markdown summary, on tokens. This is the product's core reading surface — a
 * summary is long Polish prose read *instead of* watching the video — so the type spec
 * (`ds-bundle/type.html`) is exact: 16.5px/28px, weight 400 (never 300 on dark).
 */
const summaryMarkdownComponents: Components = {
  p: ({ children }) => <p className="text-foreground text-[16.5px] leading-[28px] font-normal">{children}</p>,
  ul: ({ children }) => (
    <ul className="text-foreground list-disc space-y-1 pl-5 text-[16.5px] leading-[28px] font-normal">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="text-foreground list-decimal space-y-1 pl-5 text-[16.5px] leading-[28px] font-normal">{children}</ol>
  ),
  li: ({ children }) => <li className="marker:text-muted-foreground">{children}</li>,
  strong: ({ children }) => <strong className="text-foreground font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  h2: ({ children }) => <h2 className="text-foreground text-lg font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="text-foreground text-sm font-semibold">{children}</h3>,
  code: ({ children }) => <code className="bg-muted text-foreground rounded px-1 py-0.5 text-xs">{children}</code>,
};

interface Props {
  children: string;
}

/**
 * The single renderer for summary Markdown. Every surface that shows a summary body goes through
 * here — the generate form's result block and the list card alike — so the `img`/`a` exclusion above
 * has exactly one definition. A second, hand-rolled renderer is how those two elements quietly come
 * back for content an attacker can steer through a transcript.
 */
export function SummaryMarkdown({ children }: Props) {
  return (
    <Markdown allowedElements={SUMMARY_ALLOWED_ELEMENTS} unwrapDisallowed components={summaryMarkdownComponents}>
      {children}
    </Markdown>
  );
}
