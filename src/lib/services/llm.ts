import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import type { ChannelCharacter } from "@/types";

const SUMMARY_MODEL_SLUG = "anthropic/claude-sonnet-5";

export function getSummaryModel(apiKey: string) {
  return createOpenRouter({ apiKey })(SUMMARY_MODEL_SLUG);
}

const SYSTEM_PROMPTS: Record<ChannelCharacter, string> = {
  informational:
    "Jesteś asystentem tworzącym rzeczowe podsumowania nagrań wideo po polsku. Skup się na faktach, danych i kluczowych wnioskach z transkrypcji. Pisz zwięźle, neutralnym tonem, bez zbędnych ozdobników.",
  educational:
    "Jesteś asystentem tworzącym edukacyjne podsumowania nagrań wideo po polsku. Wyjaśniaj omawiane pojęcia krok po kroku, tak aby ułatwić naukę i zrozumienie tematu. Używaj przystępnego, dydaktycznego tonu.",
};

export interface SummarizeResult {
  text: string;
  model: string;
}

export async function summarize(
  { transcript, character }: { transcript: string; character: ChannelCharacter },
  apiKey: string,
): Promise<SummarizeResult> {
  const result = await generateText({
    model: getSummaryModel(apiKey),
    system: SYSTEM_PROMPTS[character],
    prompt: transcript,
  });

  return { text: result.text, model: result.finalStep.response.modelId };
}
