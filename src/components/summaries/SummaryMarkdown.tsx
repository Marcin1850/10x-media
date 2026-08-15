import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

/**
 * Elements the summary is allowed to render. LLM output is untrusted (transcript content can steer
 * it), so `img` and `a` are excluded: an image would make the viewer's browser fetch an
 * attacker-controlled URL, and a link would offer an attacker-controlled navigation target. Anything
 * outside this list is unwrapped, so its text still shows.
 *
 * This list is deliberately wider than what either system prompt (`llm.ts`) asks the model to produce.
 * Real production output has already contradicted both prompts once each — an unrequested `# `/`## `
 * heading landed twice under a prompt that never mentions headings at all (see `change.md`'s Finding 3
 * and 9) — so every element plain CommonMark or GFM can produce is covered here rather than only the
 * ones the prompts happen to demonstrate. `remark-gfm` (tables, strikethrough, task lists, autolinks)
 * is wired in below for the same reason: nothing stops the model reaching for a comparison table.
 *
 * `remark-gfm`'s autolinks become `a` nodes like any other link — `allowedElements`/`unwrapDisallowed`
 * runs at the final React-rendering step, after every remark/rehype plugin, so the `a`/`img` exclusion
 * above already covers them with no extra handling needed.
 */
const SUMMARY_ALLOWED_ELEMENTS = [
  "p",
  "ul",
  "ol",
  "li",
  "strong",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "hr",
  "br",
  "pre",
  "code",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "del",
  "input",
];

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
  // Sized off `ds-bundle/type.html`'s `.body-spec h3` (18px/600/1.35), the one spec that actually
  // covers a heading *inside* the reading surface — `--font-display` is explicitly "never used for
  // summary bodies" there, so these stay on the inherited `--font-sans`. h1/h2 scaled up from that
  // 18px anchor so they don't collide with h3 rather than the previous xl/lg/sm guess, which put h3
  // at 14px — smaller than the 16.5px body text it was supposed to organise.
  //
  // `pt-2` rather than `mt-2`: the parent (`SummaryCard.tsx`'s content wrapper) applies `space-y-2`
  // between every direct child via a `> :not([hidden]) ~ :not([hidden])` selector, whose specificity
  // beats a plain `.mt-2` utility on the child — so a margin-based gap here would be silently
  // overridden and produce no visible change. Padding isn't touched by `space-y-*`, so it stacks on
  // top of that baseline gap, giving a heading visibly more room before it than an ordinary
  // paragraph-to-paragraph gap gets — a second, non-color channel (rhythm) alongside size, the same
  // "differentiate on more than one axis" approach `CharacterBadge` already uses.
  h1: ({ children }) => <h1 className="text-foreground pt-2 text-[22px] leading-[1.35] font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="text-foreground pt-2 text-[20px] leading-[1.35] font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="text-foreground pt-2 text-[18px] leading-[1.35] font-semibold">{children}</h3>,
  // Neither prompt sanctions a heading level deeper than `###` (h3) — h4-h6 flatten to h3's exact
  // treatment rather than shrinking further, so a heading can never re-land smaller than body text,
  // the bug this whole element just got fixed for.
  h4: ({ children }) => <h4 className="text-foreground pt-2 text-[18px] leading-[1.35] font-semibold">{children}</h4>,
  h5: ({ children }) => <h5 className="text-foreground pt-2 text-[18px] leading-[1.35] font-semibold">{children}</h5>,
  h6: ({ children }) => <h6 className="text-foreground pt-2 text-[18px] leading-[1.35] font-semibold">{children}</h6>,
  // Differentiated by border + italic + a muted value, not a new colour — the same non-hue approach
  // `CharacterBadge` already uses.
  blockquote: ({ children }) => (
    <blockquote className="border-border text-muted-foreground border-l-2 pl-4 italic">{children}</blockquote>
  ),
  // Unwrapping an `hr` removes it with no trace (it has no children to fall back on) — worse than
  // rendering it plainly, so it gets a real divider instead.
  hr: () => <hr className="border-border my-2" />,
  // Unwrapping a `br` silently merges two lines into one; passing it through avoids that.
  br: () => <br />,
  // Neither prompt permits a fenced code block ("do not wrap the answer in a code block"), so this is
  // a safety net rather than an expected path. `whitespace-pre-wrap` keeps line breaks intact if one
  // ever leaks through anyway — the nested `code` below otherwise collapses multi-line content into a
  // single inline chip.
  pre: ({ children }) => (
    <pre className="bg-muted text-foreground overflow-x-auto rounded p-2 text-xs whitespace-pre-wrap">{children}</pre>
  ),
  code: ({ children }) => <code className="bg-muted text-foreground rounded px-1 py-0.5 text-xs">{children}</code>,
  // `overflow-x-auto` on the wrapper, not the table itself, so a wide comparison table scrolls inside
  // the card at the squeeze/mobile widths instead of forcing the whole card wider.
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="border-border border-collapse text-[16.5px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-border border-b">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr className="border-border border-b">{children}</tr>,
  th: ({ children }) => (
    <th className="text-foreground px-2 py-1 text-left font-semibold whitespace-nowrap">{children}</th>
  ),
  td: ({ children }) => <td className="text-foreground px-2 py-1 align-top">{children}</td>,
  del: ({ children }) => <del className="text-muted-foreground line-through">{children}</del>,
  // GFM task-list checkbox — rendered content, not a form, so it is always `disabled`: nothing in this
  // surface should be user-interactive.
  input: ({ checked }) => (
    <input type="checkbox" checked={checked ?? false} disabled className="accent-foreground align-middle" />
  ),
};

interface Props {
  children: string;
}

/**
 * The single renderer for summary Markdown — currently just `SummaryCard`'s expanded body, but kept
 * as one component rather than inlined there so the `img`/`a` exclusion above has exactly one
 * definition if a second surface (e.g. a generate-form result block) ever needs to show a summary
 * body too. A second, hand-rolled renderer is how those two elements quietly come back for content an
 * attacker can steer through a transcript.
 */
export function SummaryMarkdown({ children }: Props) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      allowedElements={SUMMARY_ALLOWED_ELEMENTS}
      unwrapDisallowed
      components={summaryMarkdownComponents}
    >
      {children}
    </Markdown>
  );
}
