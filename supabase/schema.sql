create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create type public.app_role as enum ('admin', 'employee');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  employee_code text not null,
  full_name text not null,
  role public.app_role not null default 'employee',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint employee_code_format check (employee_code ~ '^[A-Z0-9]{3,20}$'),
  constraint admin_code_has_letter check (role <> 'admin' or employee_code ~ '[A-Z]')
);

create table public.profile_credentials (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  pin_hash text not null,
  updated_at timestamptz not null default now()
);

create or replace function public.set_profile_pin(target_profile_id uuid, plain_pin text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if plain_pin !~ '^\d{4}$' then
    raise exception 'PIN must be exactly 4 digits';
  end if;

  insert into public.profile_credentials (profile_id, pin_hash, updated_at)
  values (target_profile_id, extensions.crypt(plain_pin, extensions.gen_salt('bf')), now())
  on conflict (profile_id)
  do update set pin_hash = excluded.pin_hash, updated_at = now();
end;
$$;

create or replace function public.reset_profile_pin(employee_code_input text, old_pin text, new_pin text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  target_profile_id uuid;
  stored_hash text;
begin
  if employee_code_input !~ '^[A-Za-z0-9]{3,20}$' then
    return false;
  end if;

  if old_pin !~ '^\d{4}$' or new_pin !~ '^\d{4}$' or old_pin = new_pin then
    return false;
  end if;

  select p.id, c.pin_hash
    into target_profile_id, stored_hash
  from public.profiles p
  join public.profile_credentials c on c.profile_id = p.id
  where lower(p.employee_code) = lower(employee_code_input)
    and p.active = true;

  if target_profile_id is null or stored_hash is null then
    return false;
  end if;

  if extensions.crypt(old_pin, stored_hash) <> stored_hash then
    return false;
  end if;

  update public.profile_credentials
  set pin_hash = extensions.crypt(new_pin, extensions.gen_salt('bf')),
      updated_at = now()
  where profile_id = target_profile_id;

  return true;
end;
$$;

create or replace function public.admin_reset_profile_pin(employee_code_input text, new_pin text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  target_profile_id uuid;
begin
  if not public.is_admin() then
    return false;
  end if;

  if employee_code_input !~ '^[A-Za-z0-9]{3,20}$' or new_pin !~ '^\d{4}$' then
    return false;
  end if;

  select id
    into target_profile_id
  from public.profiles
  where lower(employee_code) = lower(employee_code_input)
    and role = 'employee'
    and active = true;

  if target_profile_id is null then
    return false;
  end if;

  perform public.set_profile_pin(target_profile_id, new_pin);
  return true;
end;
$$;

create or replace function public.admin_delete_employee(employee_code_input text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    return false;
  end if;

  if employee_code_input !~ '^[A-Za-z0-9]{3,20}$' then
    return false;
  end if;

  update public.profiles
  set active = false
  where lower(employee_code) = lower(employee_code_input)
    and role = 'employee'
    and active = true;

  return found;
end;
$$;

create table public.monthly_targets (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.profiles(id) on delete cascade,
  target_month date not null,
  target_name text not null default 'Monthly target',
  amount numeric(12, 0) not null check (amount >= 0),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint target_name_not_blank check (length(trim(target_name)) > 0),
  constraint target_month_starts_on_first check (extract(day from target_month) = 1)
);

create table public.recovery_entries (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.profiles(id) on delete cascade,
  recovery_date date not null,
  amount numeric(12, 0) not null check (amount > 0),
  created_at timestamptz not null default now(),
  constraint six_month_recovery_window check (
    recovery_date >= date_trunc('month', current_date)::date - interval '5 months'
  )
);

create or replace view public.monthly_progress as
select
  p.id as employee_id,
  p.employee_code,
  p.full_name,
  t.target_month,
  coalesce(t.target_name, 'Monthly target') as target_name,
  coalesce(t.amount, 0) as target_amount,
  coalesce(sum(r.amount), 0) as recovered_amount,
  case
    when coalesce(t.amount, 0) = 0 then 0
    else round((coalesce(sum(r.amount), 0) / t.amount) * 100, 2)
  end as progress_percent
from public.profiles p
left join (
  select employee_id, target_month, string_agg(target_name, ' + ' order by created_at, id) as target_name,
    sum(amount) as amount
  from public.monthly_targets
  group by employee_id, target_month
) t on t.employee_id = p.id
left join public.recovery_entries r
  on r.employee_id = p.id
  and date_trunc('month', r.recovery_date)::date = t.target_month
where p.role = 'employee' and p.active = true
group by p.id, p.employee_code, p.full_name, t.target_month, t.target_name, t.amount;

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
      and active = true
  );
$$;

alter table public.profiles enable row level security;
alter table public.profile_credentials enable row level security;
alter table public.monthly_targets enable row level security;
alter table public.recovery_entries enable row level security;

create policy "profiles_select_team"
on public.profiles for select
to authenticated
using (active = true);

create policy "profiles_admin_insert"
on public.profiles for insert
to authenticated
with check (public.is_admin());

create policy "profiles_admin_update"
on public.profiles for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "credentials_admin_only"
on public.profile_credentials for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "targets_select_team"
on public.monthly_targets for select
to authenticated
using (
  target_month >= date_trunc('month', current_date)::date - interval '5 months'
);

create policy "targets_admin_write"
on public.monthly_targets for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "recoveries_select_team"
on public.recovery_entries for select
to authenticated
using (
  recovery_date >= date_trunc('month', current_date)::date - interval '5 months'
);

create policy "recoveries_employee_insert_own"
on public.recovery_entries for insert
to authenticated
with check (
  employee_id = auth.uid()
  and recovery_date >= date_trunc('month', current_date)::date - interval '5 months'
);

create index profiles_role_active_idx on public.profiles (role, active);
create unique index profiles_active_employee_code_idx on public.profiles (lower(employee_code)) where active = true;
create unique index profiles_single_admin_idx on public.profiles ((role)) where role = 'admin';
create index monthly_targets_month_idx on public.monthly_targets (target_month);
create index recovery_entries_employee_date_idx on public.recovery_entries (employee_id, recovery_date);

-- Browser-safe application RPC layer for Tracker-Board.
-- These functions support Employee ID + PIN login without exposing PIN hashes.
alter table public.profiles drop constraint if exists profiles_id_fkey;
alter table public.profiles drop constraint if exists profiles_employee_code_key;
alter table public.profiles alter column id set default gen_random_uuid();
create unique index if not exists profiles_active_employee_code_idx
on public.profiles (lower(employee_code))
where active = true;

create or replace function public.app_verify_pin(employee_code_input text, plain_pin text)
returns table (
  profile_id uuid,
  employee_code text,
  full_name text,
  role public.app_role
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if employee_code_input !~ '^[A-Za-z0-9]{3,20}$' or plain_pin !~ '^\d{4}$' then
    return;
  end if;

  return query
  select p.id, p.employee_code, p.full_name, p.role
  from public.profiles p
  join public.profile_credentials c on c.profile_id = p.id
  where lower(p.employee_code) = lower(employee_code_input)
    and p.active = true
    and extensions.crypt(plain_pin, c.pin_hash) = c.pin_hash
  limit 1;
end;
$$;

create or replace function public.app_has_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where role = 'admin' and active = true
  );
$$;

create or replace function public.app_setup_admin(employee_code_input text, full_name_input text, plain_pin text)
returns table (
  profile_id uuid,
  employee_code text,
  full_name text,
  role public.app_role
)
language plpgsql
security definer
set search_path = public
as $$
declare
  created_profile_id uuid;
begin
  if public.app_has_admin() then
    raise exception 'Admin is already configured';
  end if;

  if employee_code_input !~ '^[A-Za-z0-9]{3,20}$' or employee_code_input !~ '[A-Za-z]' then
    raise exception 'Admin ID must be 3-20 letters/numbers and include a letter';
  end if;

  if length(trim(full_name_input)) = 0 or plain_pin !~ '^\d{4}$' then
    raise exception 'Name and 4 digit PIN are required';
  end if;

  insert into public.profiles (employee_code, full_name, role, active)
  values (upper(employee_code_input), trim(full_name_input), 'admin', true)
  returning id into created_profile_id;

  perform public.set_profile_pin(created_profile_id, plain_pin);

  return query
  select p.id, p.employee_code, p.full_name, p.role
  from public.profiles p
  where p.id = created_profile_id;
end;
$$;

create or replace function public.app_snapshot()
returns jsonb
language sql
security definer
set search_path = public
as $$
  with active_profiles as (
    select id, employee_code, full_name, role, active
    from public.profiles
    where active = true
  ),
  target_rows as (
    select
      t.id,
      p.employee_code as employee_id,
      to_char(t.target_month, 'YYYY-MM') as month,
      t.target_name as name,
      t.amount
    from public.monthly_targets t
    join active_profiles p on p.id = t.employee_id
    where t.target_month >= date_trunc('month', current_date)::date - interval '5 months'
  ),
  recovery_rows as (
    select
      r.id,
      p.employee_code as employee_id,
      r.recovery_date as date,
      r.amount
    from public.recovery_entries r
    join active_profiles p on p.id = r.employee_id
    where r.recovery_date >= date_trunc('month', current_date)::date - interval '5 months'
  )
  select jsonb_build_object(
    'employees', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', employee_code,
        'uuid', id,
        'name', full_name,
        'role', role,
        'active', active
      ) order by role, employee_code)
      from active_profiles
    ), '[]'::jsonb),
    'targets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id,
        'employeeId', employee_id,
        'month', month,
        'name', name,
        'amount', amount
      ))
      from target_rows
    ), '[]'::jsonb),
    'recoveries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id,
        'employeeId', employee_id,
        'date', date,
        'amount', amount
      ) order by date desc)
      from recovery_rows
    ), '[]'::jsonb)
  );
$$;

create or replace function public.app_create_employee(
  admin_code_input text,
  admin_pin text,
  employee_code_input text,
  full_name_input text,
  employee_pin text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  admin_profile record;
  created_profile_id uuid;
begin
  select * into admin_profile
  from public.app_verify_pin(admin_code_input, admin_pin)
  where role = 'admin'
  limit 1;

  if admin_profile.profile_id is null then
    return false;
  end if;

  if employee_code_input !~ '^[A-Za-z0-9]{3,20}$'
    or length(trim(full_name_input)) = 0
    or employee_pin !~ '^\d{4}$' then
    return false;
  end if;

  insert into public.profiles (employee_code, full_name, role, active)
  values (upper(employee_code_input), trim(full_name_input), 'employee', true)
  returning id into created_profile_id;

  perform public.set_profile_pin(created_profile_id, employee_pin);
  return true;
exception
  when unique_violation then
    return false;
end;
$$;

create or replace function public.app_admin_reset_pin(
  admin_code_input text,
  admin_pin text,
  employee_code_input text,
  new_pin text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  admin_profile record;
  target_profile_id uuid;
begin
  select * into admin_profile
  from public.app_verify_pin(admin_code_input, admin_pin)
  where role = 'admin'
  limit 1;

  if admin_profile.profile_id is null then
    return false;
  end if;

  if employee_code_input !~ '^[A-Za-z0-9]{3,20}$' or new_pin !~ '^\d{4}$' then
    return false;
  end if;

  select id into target_profile_id
  from public.profiles
  where lower(employee_code) = lower(employee_code_input)
    and role = 'employee'
    and active = true;

  if target_profile_id is null then
    return false;
  end if;

  perform public.set_profile_pin(target_profile_id, new_pin);
  return true;
end;
$$;

create or replace function public.app_delete_employee(
  admin_code_input text,
  admin_pin text,
  employee_code_input text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  admin_profile record;
begin
  select * into admin_profile
  from public.app_verify_pin(admin_code_input, admin_pin)
  where role = 'admin'
  limit 1;

  if admin_profile.profile_id is null or employee_code_input !~ '^[A-Za-z0-9]{3,20}$' then
    return false;
  end if;

  update public.profiles
  set active = false
  where lower(employee_code) = lower(employee_code_input)
    and role = 'employee'
    and active = true;

  return found;
end;
$$;

create or replace function public.app_delete_target(
  target_id_input uuid,
  admin_code_input text,
  admin_pin text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.app_verify_pin(admin_code_input, admin_pin)
    where role = 'admin'
  ) then
    return false;
  end if;

  delete from public.monthly_targets where id = target_id_input;
  return found;
end;
$$;

revoke all on function public.app_delete_target(uuid, text, text) from public;
grant execute on function public.app_delete_target(uuid, text, text) to anon, authenticated;

create or replace function public.app_save_target(
  target_id_input uuid,
  admin_code_input text,
  admin_pin text,
  employee_code_input text,
  month_input text,
  target_name_input text,
  target_amount numeric
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  admin_profile record;
  target_employee_id uuid;
  target_month_date date;
begin
  select * into admin_profile
  from public.app_verify_pin(admin_code_input, admin_pin)
  where role = 'admin'
  limit 1;

  if admin_profile.profile_id is null then
    return false;
  end if;

  if target_id_input is null or employee_code_input is null or month_input is null
    or target_name_input is null or target_amount is null
    or target_amount > 999999999999
    or employee_code_input !~ '^[A-Za-z0-9]{3,20}$'
    or month_input !~ '^\d{4}-\d{2}$'
    or length(trim(target_name_input)) = 0
    or target_amount < 0
    or target_amount <> trunc(target_amount) then
    return false;
  end if;

  target_month_date := (month_input || '-01')::date;

  select id into target_employee_id
  from public.profiles
  where lower(employee_code) = lower(employee_code_input)
    and role = 'employee'
    and active = true;

  if target_employee_id is null then
    return false;
  end if;

  insert into public.monthly_targets (id, employee_id, target_month, target_name, amount, created_by, updated_at)
  values (target_id_input, target_employee_id, target_month_date, trim(target_name_input), target_amount, admin_profile.profile_id, now())
  on conflict (id)
  do update set
    target_name = excluded.target_name,
    amount = excluded.amount,
    updated_at = now()
  where monthly_targets.employee_id = target_employee_id
    and monthly_targets.target_month = target_month_date;

  return found;
end;
$$;

create or replace function public.app_add_recovery(
  employee_code_input text,
  employee_pin text,
  recovery_date_input date,
  recovery_amount numeric
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  employee_profile record;
begin
  select * into employee_profile
  from public.app_verify_pin(employee_code_input, employee_pin)
  where role = 'employee'
  limit 1;

  if employee_profile.profile_id is null
    or recovery_amount <= 0
    or recovery_amount <> trunc(recovery_amount)
    or recovery_date_input < date_trunc('month', current_date)::date - interval '5 months' then
    return false;
  end if;

  insert into public.recovery_entries (employee_id, recovery_date, amount)
  values (employee_profile.profile_id, recovery_date_input, recovery_amount);

  return true;
end;
$$;

create or replace function public.app_update_recovery(
  employee_code_input text,
  employee_pin text,
  entry_id_input uuid,
  recovery_date_input date,
  recovery_amount numeric
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  employee_profile record;
begin
  select * into employee_profile
  from public.app_verify_pin(employee_code_input, employee_pin)
  where role = 'employee'
  limit 1;

  if employee_profile.profile_id is null
    or recovery_amount <= 0
    or recovery_amount <> trunc(recovery_amount)
    or recovery_date_input < date_trunc('month', current_date)::date - interval '5 months' then
    return false;
  end if;

  update public.recovery_entries
  set recovery_date = recovery_date_input,
      amount = recovery_amount
  where id = entry_id_input
    and employee_id = employee_profile.profile_id;

  return found;
end;
$$;

create or replace function public.app_delete_recovery(
  employee_code_input text,
  employee_pin text,
  entry_id_input uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  employee_profile record;
begin
  select * into employee_profile
  from public.app_verify_pin(employee_code_input, employee_pin)
  where role = 'employee'
  limit 1;

  if employee_profile.profile_id is null then
    return false;
  end if;

  delete from public.recovery_entries
  where id = entry_id_input
    and employee_id = employee_profile.profile_id;

  return found;
end;
$$;

grant execute on function public.app_verify_pin(text, text) to anon, authenticated;
grant execute on function public.app_has_admin() to anon, authenticated;
grant execute on function public.app_setup_admin(text, text, text) to anon, authenticated;
grant execute on function public.app_snapshot() to anon, authenticated;
grant execute on function public.app_create_employee(text, text, text, text, text) to anon, authenticated;
grant execute on function public.app_admin_reset_pin(text, text, text, text) to anon, authenticated;
grant execute on function public.app_delete_employee(text, text, text) to anon, authenticated;
grant execute on function public.app_save_target(uuid, text, text, text, text, text, numeric) to anon, authenticated;
grant execute on function public.app_add_recovery(text, text, date, numeric) to anon, authenticated;
grant execute on function public.app_update_recovery(text, text, uuid, date, numeric) to anon, authenticated;
grant execute on function public.app_delete_recovery(text, text, uuid) to anon, authenticated;
grant execute on function public.reset_profile_pin(text, text, text) to anon, authenticated;
