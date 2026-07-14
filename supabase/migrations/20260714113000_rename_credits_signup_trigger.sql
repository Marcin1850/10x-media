-- Migration: give the credits signup seed feature-specific names
-- Created: 20260714113000
--
-- 20260712175240 installed `public.handle_new_user()` + `on_auth_user_created` — the exact names
-- from Supabase's canonical profile-seeding docs. Because it used `create or replace function` and
-- `drop trigger if exists`, it would silently replace an unrelated signup trigger of the same name
-- (a profiles/onboarding seed added via the dashboard, a template, or another repo) rather than
-- failing. No such collision exists in this project's migrations, but the names claim shared ground
-- this feature does not own. Renaming to credits-specific names makes ownership explicit and lets a
-- future profiles seed coexist as its own trigger on the same table.

-- Same body as the original seed, under a name that says which feature owns it.
create or replace function public.handle_new_user_credits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_credits (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- Swap the trigger over. Triggers on the same table fire in name order, so a future
-- `on_auth_user_profiles_created` can be added independently without touching this one.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_credits_created
  after insert on auth.users
  for each row execute function public.handle_new_user_credits();

-- Release the generic name. Deliberately RESTRICT (the default), not CASCADE: if anything else in
-- the database still depends on this function, this migration must fail loudly rather than quietly
-- delete another feature's automation.
drop function if exists public.handle_new_user();
