import { useRef } from "react";
import { UserIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTopUpAction, TopUpNotice } from "@/components/account/TopUpAction";
import { copy } from "@/lib/copy";

/**
 * The one avatar menu the whole app shares (wireframe answer #1). Account is reached only from
 * here, never from main navigation, so it does not compete with Summaries.
 */
export function AccountMenu() {
  const signOutFormRef = useRef<HTMLFormElement>(null);
  const { revealed, trigger, dismiss } = useTopUpAction();

  return (
    <>
      {/* Sign-out keeps posting to the existing endpoint; a hidden form lets the menu item submit
          it without turning the whole menu into a form. */}
      <form ref={signOutFormRef} method="POST" action="/api/auth/signout" className="hidden" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon" aria-label={copy.nav.account}>
            <UserIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <a href="/account">{copy.nav.account}</a>
          </DropdownMenuItem>
          {/* preventDefault keeps the menu open on select — the notice trigger() reveals must stay
              visible rather than being unmounted the instant Radix closes the menu. The item is
              the sole interactive control here; the notice below renders outside it so Radix's
              roving-focus menuitem model never has to account for the nested dismiss button. */}
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              trigger();
            }}
          >
            {copy.nav.topUp}
          </DropdownMenuItem>
          {revealed ? (
            <div className="px-2">
              <TopUpNotice dismiss={dismiss} />
            </div>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              signOutFormRef.current?.requestSubmit();
            }}
          >
            {copy.nav.signOut}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
