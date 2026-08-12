import { pl } from "./pl";

/** The shape every locale file must satisfy. Single-locale today; enforced from day one. */
export type Copy = typeof pl;

export const copy: Copy = pl;
