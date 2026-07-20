import {
  SUPABASE_URL,
  SUPABASE_KEY,
  SUPADATA_API_KEY,
  OPENROUTER_API_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
} from "astro:env/server";

export interface ConfigStatus {
  name: string;
  configured: boolean;
  message: string;
  docsUrl?: string;
  docsLabel?: string;
}

export const configStatuses: ConfigStatus[] = [
  {
    name: "Supabase",
    configured: Boolean(SUPABASE_URL && SUPABASE_KEY),
    message: "Supabase is not configured — authentication features are disabled.",
    docsUrl: "https://github.com/Marcin1850/10x-media#supabase-configuration",
    docsLabel: "See the configuration guide",
  },
  {
    // The service-role key belongs here even though it is not a transcript/LLM secret: generation
    // debits credits before the paid call, and only the admin client can refund them. The generate
    // endpoint refuses to run without it, so the notice must reflect that.
    name: "Transcript / LLM",
    configured: Boolean(SUPADATA_API_KEY && OPENROUTER_API_KEY && SUPABASE_SERVICE_ROLE_KEY),
    message: "Transcript/LLM is not configured — summary generation is disabled.",
  },
];

export const missingConfigs = configStatuses.filter((s) => !s.configured);
