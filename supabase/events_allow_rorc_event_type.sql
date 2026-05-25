alter table public.events
  drop constraint if exists events_event_type_check;

alter table public.events
  add constraint events_event_type_check check (
    event_type in (
      'rental',
      'open_gym',
      'maintenance',
      'private_event',
      'public_event',
      'general',
      'rorc'
    )
  );
