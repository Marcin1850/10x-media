import { useState } from "react";
import { CircleAlert, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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

  function close() {
    if (submitting) return;
    setOpen(false);
    setConfirmValue("");
    setError(null);
  }

  async function handleDelete() {
    if (!canConfirm) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/account/delete", { method: "POST" });
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
    <>
      <Button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        className="rounded-lg bg-red-600 px-4 py-2 font-medium text-white transition-colors hover:bg-red-500"
      >
        <Trash2 className="size-4" />
        Delete my account
      </Button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-account-title"
          onClick={close}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-900/90 p-6 text-white shadow-2xl backdrop-blur-xl"
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <div className="flex items-start justify-between gap-4">
              <h2 id="delete-account-title" className="text-xl font-bold text-red-300">
                Delete your account
              </h2>
              <button
                type="button"
                onClick={close}
                disabled={submitting}
                aria-label="Close"
                className="text-white/50 transition-colors hover:text-white disabled:opacity-40"
              >
                <X className="size-5" />
              </button>
            </div>

            <p className="mt-3 text-sm text-blue-100/80">
              This permanently deletes your account and <strong>all associated data</strong> — every video and summary.
              This action cannot be undone.
            </p>

            <label htmlFor="delete-confirm" className="mt-5 mb-1 block text-sm text-blue-100/80">
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

            {error ? (
              <p className="mt-3 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-900/30 px-3 py-2 text-sm text-red-300">
                <CircleAlert className="size-4 shrink-0" />
                {error}
              </p>
            ) : null}

            <div className="mt-6 flex justify-end gap-3">
              <Button
                type="button"
                onClick={close}
                disabled={submitting}
                className="rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/20"
              >
                Cancel
              </Button>
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
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
