import { z } from "zod";
import type { APIRoute } from "astro";
import { SUPADATA_API_KEY, OPENROUTER_API_KEY } from "astro:env/server";
import { createClient } from "@/lib/supabase";
import { fetchTranscript } from "@/lib/services/transcript";
import { summarize } from "@/lib/services/llm";
import { extractYoutubeId, upsertVideoAndAppendSummary } from "@/lib/services/summaries";

export const prerender = false;

const probeSchema = z.object({
  url: z.string().refine((url) => extractYoutubeId(url) !== null, {
    message: "url must be a valid YouTube video URL",
  }),
  character: z.enum(["informational", "educational"]),
});

export const POST: APIRoute = async (context) => {
  if (!SUPADATA_API_KEY || !OPENROUTER_API_KEY) {
    return Response.json({ error: "Transcript/LLM services are not configured" }, { status: 503 });
  }

  if (!context.locals.user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body: unknown = await context.request.json().catch(() => null);
  const parsed = probeSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const { url, character } = parsed.data;
  const youtubeId = extractYoutubeId(url);
  if (!youtubeId) {
    return Response.json({ error: "url must be a valid YouTube video URL" }, { status: 400 });
  }

  const transcript = await fetchTranscript({ url, lang: "pl" }, SUPADATA_API_KEY);
  if (!transcript.ok) {
    return Response.json({ error: "Transcript unavailable for this video" }, { status: 422 });
  }

  const { text, model } = await summarize({ transcript: transcript.content, character }, OPENROUTER_API_KEY);

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return Response.json({ error: "Supabase is not configured" }, { status: 503 });
  }

  // createClient returns supabase-js's default untyped client — this codebase has no generated
  // Database types yet, so passing it where the service expects its explicit Row/Insert shapes
  // is a real, unavoidable `any` gap (not a fixable unsafe-argument).
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const { videoId, summaryId } = await upsertVideoAndAppendSummary(supabase, {
    userId: context.locals.user.id,
    url,
    youtubeId,
    character,
    content: text,
    model,
    resolvedVia: transcript.resolvedVia,
  });

  return Response.json({ summary: text, model, videoId, summaryId });
};
