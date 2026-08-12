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
      emptyHint: "Użyj „Nowe podsumowanie”, aby wygenerować pierwsze.",
      emptyFiltered: "Żadne podsumowanie nie pasuje do tego filtra.",
      showAll: "Pokaż wszystkie podsumowania",
    },
    card: {
      generatedOn: (date: string) => `Wygenerowano ${date}`,
      expand: "Rozwiń",
      collapse: "Zwiń",
      summaryOf: (title: string) => `podsumowanie: ${title}`,
    },
  },
  generate: {},
  account: {},
  landing: {},
  errors: {},
};
