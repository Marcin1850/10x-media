import { Supadata, SupadataError } from "@supadata/js";

export type TranscriptResult = { ok: true; content: string; lang: string } | { ok: false; reason: "unavailable" };

export async function fetchTranscript(
  { url, lang = "pl" }: { url: string; lang?: string },
  apiKey: string,
): Promise<TranscriptResult> {
  const supadata = new Supadata({ apiKey });

  try {
    const result = await supadata.transcript({ url, lang, text: true, mode: "auto" });

    if (!("content" in result) || typeof result.content !== "string") {
      return { ok: false, reason: "unavailable" };
    }

    return { ok: true, content: result.content, lang: result.lang };
  } catch (error) {
    if (error instanceof SupadataError && error.error === "transcript-unavailable") {
      return { ok: false, reason: "unavailable" };
    }
    throw error;
  }
}
