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
 * Tailwind-styled element map for the Markdown summary, matching the cosmic theme. Raw HTML in the
 * summary is escaped by react-markdown's default (no rehype-raw), so no extra sanitizer is needed.
 */
const summaryMarkdownComponents: Components = {
  p: ({ children }) => <p className="text-sm leading-relaxed text-blue-50/90">{children}</p>,
  ul: ({ children }) => <ul className="list-disc space-y-1 pl-5 text-sm text-blue-50/90">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5 text-sm text-blue-50/90">{children}</ol>,
  li: ({ children }) => <li className="marker:text-blue-200/40">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  h2: ({ children }) => <h2 className="text-base font-semibold text-white">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-semibold text-white">{children}</h3>,
  code: ({ children }) => <code className="rounded bg-white/10 px-1 py-0.5 text-xs">{children}</code>,
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
