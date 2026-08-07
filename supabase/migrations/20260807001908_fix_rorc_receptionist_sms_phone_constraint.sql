alter table public.rorc_receptionist_sms_consent
  drop constraint if exists rorc_receptionist_sms_phone_check;

alter table public.rorc_receptionist_sms_consent
  add constraint rorc_receptionist_sms_phone_check
  check (phone_e164 ~ E'^\\+[1-9][0-9]{7,14}$');
