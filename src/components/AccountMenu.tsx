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
import { TopUpAction } from "@/components/account/TopUpAction";
import { copy } from "@/lib/copy";

/**
 * The one avatar menu the whole app shares (wireframe answer #1). Account is reached only from
 * here, never from main navigation, so it does not compete with Summaries.
 */
export function AccountMenu() {
  const signOutFormRef = useRef<HTMLFormElement>(null);

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
          {/* preventDefault keeps the menu open on click — the notice TopUpAction reveals must stay
              visible inside it rather than being unmounted the instant Radix closes the menu. */}
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
            }}
            className="cursor-default focus:bg-transparent"
          >
            <TopUpAction variant="menu-item" />
          </DropdownMenuItem>
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
