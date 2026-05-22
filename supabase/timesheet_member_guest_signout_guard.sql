-- Keeps currently-signed-in data consistent even when an older app version only signs out the member row.
-- Run in Supabase SQL editor.

create or replace function public.sign_out_member_guests()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.signed_out_at is null
     and new.signed_out_at is not null
     and new.member_or_guest = 'Member'
     and new.member_id is not null then
    update public.timesheet_entries
    set signed_out_at = new.signed_out_at
    where member_or_guest = 'Guest'
      and member_entered_with_id = new.member_id
      and signed_out_at is null;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sign_out_member_guests on public.timesheet_entries;
create trigger trg_sign_out_member_guests
after update of signed_out_at on public.timesheet_entries
for each row
execute function public.sign_out_member_guests();
