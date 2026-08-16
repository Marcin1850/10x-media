import { useSyncExternalStore } from "react";

function subscribe() {
  return function unsubscribe() {
    // The store never changes after mount, so there is nothing to unsubscribe from.
  };
}

/**
 * `false` on the server and on the client's first render (so hydration output matches SSR exactly),
 * `true` on every render after that. `useSyncExternalStore` rather than `useState` + `useEffect`: the
 * mount transition needs to happen as part of React's hydration bookkeeping, not as a follow-up
 * `setState` call inside an effect — the store never actually changes, so `subscribe` is a no-op.
 */
export function useHasMounted(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
