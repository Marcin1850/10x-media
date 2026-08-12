import React, { useRef, useState } from "react";
import { Mail, Lock, LogIn } from "lucide-react";
import { FormField } from "@/components/auth/FormField";
import { PasswordToggle } from "@/components/auth/PasswordToggle";
import { SubmitButton } from "@/components/auth/SubmitButton";
import { ServerError } from "@/components/auth/ServerError";
import { copy } from "@/lib/copy";

interface Props {
  serverError?: string | null;
}

export default function SignInForm({ serverError }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [submitting, setSubmitting] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  function validate() {
    const next: typeof errors = {};
    if (!email.trim()) {
      next.email = copy.auth.validation.emailRequired;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      next.email = copy.auth.validation.emailInvalid;
    }
    if (!password) {
      next.password = copy.auth.validation.passwordRequired;
    }
    setErrors(next);
    if (next.email) {
      emailRef.current?.focus();
    } else if (next.password) {
      passwordRef.current?.focus();
    }
    return Object.keys(next).length === 0;
  }

  function clearError(field: keyof typeof errors) {
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  function handleSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    if (!validate()) {
      e.preventDefault();
      return;
    }
    setSubmitting(true);
  }

  return (
    <form method="POST" action="/api/auth/signin" className="space-y-4" onSubmit={handleSubmit} noValidate>
      <FormField
        id="email"
        type="email"
        label={copy.auth.fields.email}
        value={email}
        onChange={(v) => {
          setEmail(v);
          clearError("email");
        }}
        placeholder={copy.auth.fields.emailPlaceholder}
        error={errors.email}
        icon={<Mail className="size-4" />}
        autoComplete="email"
        inputRef={emailRef}
      />

      <FormField
        id="password"
        label={copy.auth.fields.password}
        type={showPassword ? "text" : "password"}
        value={password}
        onChange={(v) => {
          setPassword(v);
          clearError("password");
        }}
        placeholder={copy.auth.fields.passwordPlaceholder}
        error={errors.password}
        icon={<Lock className="size-4" />}
        autoComplete="current-password"
        inputRef={passwordRef}
        endContent={
          <PasswordToggle
            visible={showPassword}
            onToggle={() => {
              setShowPassword(!showPassword);
            }}
            showLabel={copy.auth.fields.showPassword}
            hideLabel={copy.auth.fields.hidePassword}
          />
        }
      />

      <ServerError message={serverError} />

      <SubmitButton pending={submitting} pendingText={copy.auth.signIn.pending} icon={<LogIn className="size-4" />}>
        {copy.auth.signIn.submit}
      </SubmitButton>
    </form>
  );
}
