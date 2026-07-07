import { SUPABASE_URL, SUPABASE_KEY, SUPADATA_API_KEY, OPENROUTER_API_KEY } from "astro:env/server";

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
    message: "Supabase nie jest skonfigurowany — funkcje uwierzytelniania są wyłączone.",
    docsUrl: "https://github.com/przeprogramowani/10x-astro-starter#supabase-configuration",
    docsLabel: "Zobacz instrukcję konfiguracji",
  },
  {
    name: "Transkrypcja / LLM",
    configured: Boolean(SUPADATA_API_KEY && OPENROUTER_API_KEY),
    message: "Transkrypcja lub LLM nie są skonfigurowane — generowanie podsumowań jest wyłączone.",
  },
];

export const missingConfigs = configStatuses.filter((s) => !s.configured);
