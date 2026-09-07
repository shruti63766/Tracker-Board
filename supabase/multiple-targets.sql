-- Run before deploying the updated frontend. Existing targets retain their IDs and amounts.
begin;
alter table public.monthly_targets drop constraint if exists monthly_targets_employee_id_target_month_key;
drop function if exists public.app_upsert_target(text, text, text, text, text, numeric);

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

grant execute on function public.app_save_target(uuid, text, text, text, text, text, numeric) to anon, authenticated;
commit;
