/**
 * The single Polish copy source. Structured per-surface so a second locale is a new file that
 * satisfies `Copy` (see `index.ts`), not another sweep across every component.
 *
 * Phase 2 populated `common` and `nav`; phase 3 adds the shell's remaining `nav` strings (the
 * top-up notice and its dismiss control, shared by the avatar menu and, from phase 7, the account
 * page's credit row). Every other namespace is added by the phase that builds the surface it
 * belongs to.
 */
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
  auth: {},
  summaries: {},
  generate: {},
  account: {},
  landing: {},
  errors: {},
};
