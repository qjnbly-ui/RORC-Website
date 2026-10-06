alter table public.sponsor_banners add column public_contact boolean not null default false;
comment on column public.sponsor_banners.public_contact is 'Manager opt-in to publish owner phone and email in the public sponsor gallery.';
