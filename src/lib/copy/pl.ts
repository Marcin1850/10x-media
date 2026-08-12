/**
 * The single Polish copy source. Structured per-surface so a second locale is a new file that
 * satisfies `Copy` (see `index.ts`), not another sweep across every component.
 *
 * Phase 2 populates only `common` and `nav` — every other namespace is added by the phase that
 * builds the surface it belongs to.
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
  },
};
