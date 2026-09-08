import { relativeTimeBucket } from "@/lib/format";

/**
 * The single Polish copy source. Structured per-surface so a second locale is a new file that
 * satisfies `Copy` (see `index.ts`), not another sweep across every component.
 *
 * Phase 2 populated `common` and `nav`; phase 3 adds the shell's remaining `nav` strings (the
 * top-up notice and its dismiss control, shared by the avatar menu and, from phase 7, the account
 * page's credit row). Every other namespace is added by the phase that builds the surface it
 * belongs to.
 */

/** Polish noun-plural class for "znak" (character): 1 / 2-4 excl. 12-14 / 5+. */
function pluralChars(n: number): string {
  if (n === 1) return "znak";
  const lastTwo = n % 100;
  const last = n % 10;
  if (last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return "znaki";
  return "znaków";
}

/**
 * The 1 / 2-4 excl. 12-14 / 5+ noun-plural class used by `relativeTime` below. "dzień" (day) needs no
 * entry here: its plural is "dni" uniformly for every count 2 and up, with no separate 2-4 form —
 * unlike week/month/year, which do distinguish one — so `relativeTime` spells that unit out directly.
 */
function pluralClass(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const lastTwo = n % 100;
  const last = n % 10;
  return last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14) ? few : many;
}

/**
 * "dzisiaj" / "wczoraj" / "N <jednostka> temu", from a bucket already decided by
 * `relativeTimeBucket` in `lib/format.ts` — that module owns which bucket a day count falls into
 * (identical for every locale); this only chooses the Polish words for it, the one part that
 * genuinely differs per language.
 */
function relativeTime(days: number): string {
  const { unit, value } = relativeTimeBucket(days);
  switch (unit) {
    case "today":
      return "dzisiaj";
    case "yesterday":
      return "wczoraj";
    case "days":
      return `${value} dni temu`;
    case "weeks":
      return `${value} ${pluralClass(value, "tydzień", "tygodnie", "tygodni")} temu`;
    case "months":
      return `${value} ${pluralClass(value, "miesiąc", "miesiące", "miesięcy")} temu`;
    case "years":
      return `${value} ${pluralClass(value, "rok", "lata", "lat")} temu`;
  }
}

export const pl = {
  common: {},
  nav: {
    summaries: "Podsumowania",
    account: "Konto",
    topUp: "Doładuj",
    signOut: "Wyloguj się",
    signIn: "Zaloguj się",
    signUp: "Zarejestruj się",
    credits: "Kredyty",
    creditsUnavailable: "saldo niedostępne",
    topUpNotice: "Samoobsługowe doładowanie nie jest jeszcze dostępne.",
    dismiss: "Zamknij",
  },
  auth: {
    signIn: {
      heading: "Zaloguj się",
      noAccount: "Nie masz konta?",
      signUpLink: "Zarejestruj się",
      submit: "Zaloguj się",
      pending: "Logowanie…",
    },
    signUp: {
      heading: "Zarejestruj się",
      haveAccount: "Masz już konto?",
      signInLink: "Zaloguj się",
      submit: "Utwórz konto",
      pending: "Tworzenie konta…",
    },
    fields: {
      email: "Email",
      emailPlaceholder: "ty@przyklad.pl",
      password: "Hasło",
      passwordPlaceholder: "Twoje hasło",
      passwordPlaceholderMin: "Min. 6 znaków",
      confirmPassword: "Potwierdź hasło",
      confirmPasswordPlaceholder: "Wpisz hasło ponownie",
      showPassword: "Pokaż hasło",
      hidePassword: "Ukryj hasło",
    },
    validation: {
      emailRequired: "Email jest wymagany",
      emailInvalid: "Podaj prawidłowy adres email",
      passwordRequired: "Hasło jest wymagane",
      passwordTooShort: (min: number) => `Hasło musi mieć co najmniej ${min} ${pluralChars(min)}`,
      confirmPasswordRequired: "Potwierdź hasło",
      passwordsDoNotMatch: "Hasła nie są identyczne",
    },
    charactersNeeded: (n: number) => `Jeszcze ${n} ${pluralChars(n)}`,
    confirmEmail: {
      autoConfirmed: {
        emoji: "✅",
        heading: "Rejestracja zakończona sukcesem",
        description: "Twoje konto zostało utworzone. Możesz się teraz zalogować.",
        linkText: "Przejdź do logowania",
      },
      pending: {
        emoji: "📧",
        heading: "Sprawdź swoją skrzynkę",
        description: "Wysłaliśmy link potwierdzający na Twój adres email. Kliknij go, aby aktywować konto.",
        linkText: "Powrót do logowania",
      },
    },
  },
  summaries: {
    page: {
      title: "Podsumowania",
      heading: "Twoje podsumowania",
    },
    character: {
      informational: "Informacyjny",
      educational: "Edukacyjny",
    },
    filters: {
      all: "Wszystkie",
      groupLabel: "Filtruj według charakteru kanału",
    },
    list: {
      unavailable: "Nie udało się wczytać Twoich podsumowań. Odśwież stronę, aby spróbować ponownie.",
      refreshNote: (url: string) =>
        `Zapisaliśmy podsumowanie ${url}, ale nie udało się odświeżyć listy. Odśwież stronę, aby je zobaczyć.`,
      empty: "Nie masz jeszcze żadnych podsumowań.",
      emptyHint: "Wklej adres URL filmu z YouTube w pasku powyżej, aby wygenerować pierwsze.",
      emptyFiltered: "Żadne podsumowanie nie pasuje do tego filtra.",
      showAll: "Pokaż wszystkie podsumowania",
    },
    card: {
      generatedOn: (date: string) => `Wygenerowano ${date}`,
      expand: "Rozwiń",
      collapse: "Zwiń",
      summaryOf: (title: string) => `podsumowanie: ${title}`,
      openVideo: (title: string) => `Otwórz na YouTube: ${title}`,
      openChannel: (channelName: string) => `Otwórz kanał na YouTube: ${channelName}`,
      /** Parenthesised suffix after the upload date, e.g. `"(3 dni temu)"` — the date alone is exact but not immediately legible as "how long ago". */
      publishedRelative: (days: number) => `(${relativeTime(days)})`,
      // The delete control (S-03). The trigger names the video for the same reason `summaryOf` and
      // `openVideo` do: a list of icon-only buttons is indistinguishable to a screen reader. There
      // is deliberately no "deleting…" string — removal is optimistic, so the card is out of the
      // list before the request resolves and an in-flight label could never render.
      deleteSummary: (title: string) => `Usuń podsumowanie: ${title}`,
      deleteQuestion: "Usunąć?",
      deleteConfirm: "Usuń",
      deleteCancel: "Anuluj",
    },
  },
  generate: {
    urlLabel: "Adres URL z YouTube",
    urlPlaceholder: "https://www.youtube.com/watch?v=...",
    urlInvalid: "Podaj prawidłowy adres URL filmu z YouTube.",
    characterLabel: "Charakter kanału",
    characters: {
      informational: { label: "Informacyjny", hint: "Kluczowe fakty i dane" },
      educational: { label: "Edukacyjny", hint: "Tematy i umiejętności do nauki" },
    },
    allowLong: "Zezwól na długie filmy (może kosztować 2 kredyty)",
    submit: "Generuj podsumowanie",
    submitPending: "Generowanie…",
    confirmSubmit: (cost: number) => `Generuj mimo to (${cost} kr.)`,
    noCredits: "Nie masz już kredytów na podsumowania. Generowanie jest wyłączone.",
    balanceUnavailable:
      "Twoje saldo kredytów jest teraz niedostępne. Nadal możesz generować — poinformujemy Cię, jeśli kredytów zabraknie.",
    gate: {
      held: (cost: number, resultingBalance: number | null) =>
        `Generowanie wstrzymane — to długi film. Koszt: ${cost} kr. Saldo po potwierdzeniu: ${
          resultingBalance ?? "—"
        } kr.`,
      reviewAction: "Przejdź do paska generowania, aby potwierdzić",
      tooExpensive: (cost: number, credits: number) => `Za mało kredytów — potrzebujesz ${cost}, masz ${credits}.`,
    },
    status: {
      generating: "Generowanie podsumowania…",
      saved: "Podsumowanie zapisane — dodawanie do listy…",
      savedRefreshFailed: "Podsumowanie zapisane. Odśwież stronę, aby zobaczyć je na liście.",
    },
    dismissFailed: "Odrzuć to nieudane generowanie",
    // Worded as a fact about the operation, not about this specific attempt — a replay of a
    // request already charged by the original attempt must read identically to a first-time
    // charge, never as "this retry charged you" (S-09 phase 9 D1).
    charged: "Za tę operację pobrano kredyt.",
    notCharged: "Nie pobrano kredytu za tę operację.",
  },
  account: {
    heading: "Konto",
    signedInAs: (email: string) => `Zalogowano jako ${email}`,
    creditsLabel: "Kredyty",
    dangerZone: {
      heading: "Strefa zagrożenia",
      description: "Trwale usuń swoje konto i wszystkie powiązane dane. Tej operacji nie można cofnąć.",
    },
    deleteDialog: {
      trigger: "Usuń moje konto",
      heading: "Usuń swoje konto",
      description:
        "Ta operacja trwale usuwa Twoje konto i wszystkie powiązane dane — każdy film i podsumowanie. Nie można jej cofnąć.",
      confirmLabel: (email: string) => `Wpisz ${email}, aby potwierdzić`,
      cancel: "Anuluj",
      confirm: "Usuń trwale",
      pending: "Usuwanie…",
    },
  },
  landing: {
    tagline: "Pierwsze podsumowania gratis",
    heroDescription:
      "Zamień listę filmów z YouTube w podsumowania, które mówią, co warto obejrzeć — i przekazują kluczową treść reszty.",
    ctaSummaries: "Przejdź do podsumowań",
    features: {
      read: {
        heading: "Czytaj zamiast oglądać",
        description:
          "Wklej link i otrzymaj najważniejsze punkty — wystarczą, aby ocenić, czy film jest wart obejrzenia w całości, bez marnowania na to czasu.",
      },
      tuned: {
        heading: "Dopasowane do treści",
        description:
          "Materiały informacyjne — fakty i wnioski. Materiały edukacyjne — pojęcia wyjaśnione krok po kroku.",
      },
      library: {
        heading: "Twoja biblioteka podsumowań",
        description:
          "Każde podsumowanie zostaje zapisane na Twoim koncie — wracaj do niego, kiedy chcesz, bez szukania filmu na nowo.",
      },
    },
    deletedToast: "Twoje konto i wszystkie dane zostały usunięte.",
  },
  errors: {
    generic: "Coś poszło nie tak. Spróbuj ponownie.",
    network: "Błąd sieci — spróbuj ponownie.",
    accountDeleteFailed: "Coś poszło nie tak. Twoje konto nie zostało usunięte.",
    accountDeleteNetwork: "Błąd sieci. Twoje konto nie zostało usunięte.",
    summaryDeleteFailed: "Nie udało się usunąć podsumowania. Spróbuj ponownie.",
    summaryDeleteNetwork: "Błąd sieci. Podsumowanie nie zostało usunięte.",
    summaryDeleteUnknown: "Nie wiemy, czy podsumowanie zostało usunięte. Odśwież stronę, aby sprawdzić.",
    alreadyGenerating: "Podsumowanie jest już generowane. Poczekaj, aż się zakończy, zanim rozpoczniesz kolejne.",
    tooLong: "Ten film jest zbyt długi, aby go podsumować.",
    noTranscript: "Brak dostępnego transkryptu dla tego filmu.",
    serviceFailed: "Usługa transkryptu lub podsumowań zawiodła. Spróbuj ponownie.",
    notConfigured: "Generowanie podsumowań nie jest skonfigurowane.",
    sessionExpired: "Twoja sesja wygasła — zaloguj się ponownie.",
    checkUrl: "Sprawdź adres URL filmu i spróbuj ponownie.",
    noCredits: "Nie masz wystarczającej liczby kredytów.",
    savedResponseInvalid:
      "Podsumowanie zostało zapisane i opłacone, ale odpowiedź serwera była niekompletna. Odśwież stronę, aby je zobaczyć.",
    /**
     * Keyed by the `code` the generate endpoint sends beside `error` — NOT translated from that
     * English string, because the string is not what carries the meaning. One status covers several
     * causes: 422 alone answers "this video has no caption track", "a transcript arrived with no
     * words in it", and "we could not reach the transcript service", and a user must do something
     * different about each. The per-status entries above would collapse all three into one sentence,
     * which is exactly why the client used to prefer the server's English copy over them.
     *
     * An unknown or absent code falls back to the per-status entry, so a code added server-side
     * before its translation lands degrades to a correct-but-generic Polish message rather than to
     * an English one or an empty card.
     */
    codes: {
      noCaptions:
        "Ten film nie ma napisów, więc nie ma czego podsumować. Podsumowujemy tylko filmy, które mają ścieżkę napisów — spróbuj z innym filmem.",
      transcriptUnavailable: "Brak dostępnego transkryptu dla tego filmu.",
      // Deliberately NOT worded as "this video has no transcript". This is the one 422 the endpoint
      // never charges for, because the failure is our outage or the vendor's — the video itself may
      // summarize perfectly on the next attempt. Copy that blamed the video would send the user away
      // from something that works, and would contradict the "nie pobrano kredytu" line beneath it.
      transcriptFetchFailed: "Nie udało się pobrać transkryptu — spróbuj ponownie za chwilę.",
      noCredits: "Nie masz już kredytów na podsumowania.",
      // The numberless fallback for the one refusal whose real copy is arithmetic. When the 402 body
      // carries `cost` and `creditsRemaining` the client renders `generate.gate.tooExpensive` with
      // them instead; this covers the body arriving without them, which is the shape a truncated or
      // older response has. Every code needs somewhere to land — see `error-codes.test.ts`.
      insufficientCredits: "Nie masz wystarczającej liczby kredytów na ten film.",

      // The generate endpoint's remaining exits. Same rule as above — one entry per thing a user must
      // do something different about, not one per `return` statement. The five identical `generic`
      // 500s and the three identical save 500s therefore share two codes between them, while the
      // three 429s keep three: "something else of yours is running", "this exact one is running" and
      // "you are asking too fast" are three different waits.
      invalidRequest: "Żądanie było nieprawidłowe. Odśwież stronę i spróbuj ponownie.",
      invalidUrl: "To nie jest poprawny adres filmu z YouTube. Sprawdź go i spróbuj ponownie.",
      notConfigured: "Generowanie podsumowań nie jest skonfigurowane.",
      // Deliberately not phrased as a fault the user can fix or has caused: the service is at a
      // temporary capacity limit and will recover on its own. 503 is shared with the configuration
      // exits above, which is exactly why this needs its own code — "it is broken" and "come back
      // shortly" are the two answers a status alone cannot tell apart.
      budgetExhausted:
        "Osiągnęliśmy chwilowy limit usługi transkrypcji, więc nowe filmy nie mogą być teraz przetwarzane. Spróbuj ponownie za jakiś czas.",
      generationBusy: "Generujesz już inne podsumowanie. Poczekaj, aż się zakończy, zanim zaczniesz kolejne.",
      generationInProgress: "To podsumowanie jest już generowane. Poczekaj, aż się zakończy.",
      transcriptRateLimited: "Zbyt wiele żądań o transkrypcję. Odczekaj chwilę i spróbuj ponownie.",
      requestAlreadyProcessed: "To żądanie zostało już przetworzone. Rozpocznij nowe generowanie.",
      transcriptTooLong: "Ten film jest zbyt długi, aby go podsumować.",
      generic: "Coś poszło nie tak. Spróbuj ponownie.",
      // Distinct from `generic` because the money is in a different place. The generic 500s fire
      // before anything was saved or charged; this one fires after the summary was generated and
      // paid for, so "spróbuj ponownie" means something different and the refund path is what the
      // user is relying on.
      saveFailed: "Coś poszło nie tak przy zapisywaniu podsumowania. Spróbuj ponownie.",
    },
  },
};
