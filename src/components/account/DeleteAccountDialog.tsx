import { useState } from "react";
import { CircleAlert, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";

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
          : "Something went wrong. Your account was not deleted.";
      setError(message);
      setSubmitting(false);
    } catch {
      setError("Network error. Your account was not deleted.");
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          type="button"
          className="rounded-lg bg-red-600 px-4 py-2 font-medium text-white transition-colors hover:bg-red-500"
        >
          <Trash2 className="size-4" />
          Delete my account
        </Button>
      </DialogTrigger>

      <DialogContent
        showCloseButton={!submitting}
        className="border-white/10 bg-slate-900/90 text-white backdrop-blur-xl sm:max-w-md"
        onEscapeKeyDown={(e) => {
          if (submitting) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (submitting) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-xl font-bold text-red-300">Delete your account</DialogTitle>
          <DialogDescription className="text-blue-100/80">
            This permanently deletes your account and <strong>all associated data</strong> — every video and summary.
            This action cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div>
          <label htmlFor="delete-confirm" className="mb-1 block text-sm text-blue-100/80">
            Type <span className="font-semibold text-white">{email}</span> to confirm
          </label>
          <input
            id="delete-confirm"
            type="text"
            value={confirmValue}
            onChange={(e) => {
              setConfirmValue(e.target.value);
            }}
            disabled={submitting}
            autoComplete="off"
            placeholder={email}
            className={cn(
              "w-full rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-white placeholder-white/30 transition-colors focus:ring-2 focus:ring-red-400 focus:outline-none disabled:opacity-50",
            )}
          />
        </div>

        {error ? (
          <p className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-900/30 px-3 py-2 text-sm text-red-300">
            <CircleAlert className="size-4 shrink-0" />
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button
              type="button"
              disabled={submitting}
              className="rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/20"
            >
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            onClick={() => void handleDelete()}
            disabled={!canConfirm}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:pointer-events-none disabled:opacity-50"
          >
            {submitting ? (
              <span className="flex items-center gap-2">
                <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Deleting...
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <Trash2 className="size-4" />
                Permanently delete
              </span>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
