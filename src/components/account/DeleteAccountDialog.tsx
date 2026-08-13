import { useState } from "react";
import { CircleAlert, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { copy } from "@/lib/copy";

interface Props {
  email: string;
}

export default function DeleteAccountDialog({ email }: Props) {
  const [open, setOpen] = useState(false);
  const [confirmValue, setConfirmValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canConfirm = confirmValue === email && !submitting;

  function handleOpenChange(next: boolean) {
    // Lock the dialog shut while a deletion is in flight so the user cannot
    // dismiss it (Escape, overlay click, close button) mid-request.
    if (submitting) return;
    setOpen(next);
    if (!next) {
      setConfirmValue("");
      setError(null);
    }
  }

  async function handleDelete() {
    if (!canConfirm) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: confirmValue }),
      });
      if (res.ok) {
        window.location.assign("/?deleted=1");
        return;
      }
      const body: unknown = await res.json().catch(() => null);
      const message =
        body && typeof body === "object" && "error" in body && typeof body.error === "string"
          ? body.error
          : copy.errors.accountDeleteFailed;
      setError(message);
      setSubmitting(false);
    } catch {
      setError(copy.errors.accountDeleteNetwork);
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="destructive">
          <Trash2 className="size-4" />
          {copy.account.deleteDialog.trigger}
        </Button>
      </DialogTrigger>

      <DialogContent
        showCloseButton={!submitting}
        className="bg-popover text-popover-foreground sm:max-w-md"
        onEscapeKeyDown={(e) => {
          if (submitting) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (submitting) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-destructive text-xl font-bold">{copy.account.deleteDialog.heading}</DialogTitle>
          <DialogDescription>{copy.account.deleteDialog.description}</DialogDescription>
        </DialogHeader>

        <div>
          <label htmlFor="delete-confirm" className="text-muted-foreground mb-1 block text-sm">
            {copy.account.deleteDialog.confirmLabel(email)}
          </label>
          <Input
            id="delete-confirm"
            type="text"
            value={confirmValue}
            onChange={(e) => {
              setConfirmValue(e.target.value);
            }}
            disabled={submitting}
            autoComplete="off"
            placeholder={email}
          />
        </div>

        {error ? (
          <p className="border-destructive bg-destructive/10 text-destructive flex items-center gap-2 rounded-lg border-2 px-3 py-2 text-sm">
            <CircleAlert className="size-4 shrink-0" />
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={submitting}>
              {copy.account.deleteDialog.cancel}
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" onClick={() => void handleDelete()} disabled={!canConfirm}>
            {submitting ? (
              <span className="flex items-center gap-2">
                <span className="border-destructive-foreground/30 border-t-destructive-foreground size-4 animate-spin rounded-full border-2" />
                {copy.account.deleteDialog.pending}
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <Trash2 className="size-4" />
                {copy.account.deleteDialog.confirm}
              </span>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
