import React, { useRef, useState } from "react";
import { Mail, Lock, UserPlus } from "lucide-react";
import { FormField } from "@/components/auth/FormField";
import { PasswordToggle } from "@/components/auth/PasswordToggle";
import { SubmitButton } from "@/components/auth/SubmitButton";
import { ServerError } from "@/components/auth/ServerError";
import { copy } from "@/lib/copy";

const MIN_PASSWORD_LENGTH = 6;

interface Props {
  serverError?: string | null;
}

export default function SignUpForm({ serverError }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string; confirmPassword?: string }>({});
  const [submitting, setSubmitting] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);

  function validate() {
    const next: typeof errors = {};

    if (!email.trim()) {
      next.email = copy.auth.validation.emailRequired;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      next.email = copy.auth.validation.emailInvalid;
    }

    if (!password) {
      next.password = copy.auth.validation.passwordRequired;
    } else if (password.length < MIN_PASSWORD_LENGTH) {
      next.password = copy.auth.validation.passwordTooShort(MIN_PASSWORD_LENGTH);
    }

    if (!confirmPassword) {
      next.confirmPassword = copy.auth.validation.confirmPasswordRequired;
    } else if (password !== confirmPassword) {
      next.confirmPassword = copy.auth.validation.passwordsDoNotMatch;
    }

    setErrors(next);
    if (next.email) {
      emailRef.current?.focus();
    } else if (next.password) {
      passwordRef.current?.focus();
    } else if (next.confirmPassword) {
      confirmPasswordRef.current?.focus();
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

  const passwordHint =
    !errors.password && password.length > 0 && password.length < MIN_PASSWORD_LENGTH ? (
      <p className="text-muted-foreground mt-1 text-xs">
        {copy.auth.charactersNeeded(MIN_PASSWORD_LENGTH - password.length)}
      </p>
    ) : undefined;

  return (
    <form method="POST" action="/api/auth/signup" className="space-y-4" onSubmit={handleSubmit} noValidate>
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
        placeholder={copy.auth.fields.passwordPlaceholderMin}
        error={errors.password}
        hint={passwordHint}
        icon={<Lock className="size-4" />}
        autoComplete="new-password"
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

      <FormField
        id="confirmPassword"
        name="confirmPassword"
        label={copy.auth.fields.confirmPassword}
        type={showConfirmPassword ? "text" : "password"}
        value={confirmPassword}
        onChange={(v) => {
          setConfirmPassword(v);
          clearError("confirmPassword");
        }}
        placeholder={copy.auth.fields.confirmPasswordPlaceholder}
        error={errors.confirmPassword}
        icon={<Lock className="size-4" />}
        autoComplete="new-password"
        inputRef={confirmPasswordRef}
        endContent={
          <PasswordToggle
            visible={showConfirmPassword}
            onToggle={() => {
              setShowConfirmPassword(!showConfirmPassword);
            }}
            showLabel={copy.auth.fields.showPassword}
            hideLabel={copy.auth.fields.hidePassword}
          />
        }
      />

      <ServerError message={serverError} />

      <SubmitButton pending={submitting} pendingText={copy.auth.signUp.pending} icon={<UserPlus className="size-4" />}>
        {copy.auth.signUp.submit}
      </SubmitButton>
    </form>
  );
}
