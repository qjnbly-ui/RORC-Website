create index if not exists rorc_receptionist_review_items_call_idx
  on public.rorc_receptionist_review_items (call_sid);

create index if not exists rorc_receptionist_review_items_reviewer_idx
  on public.rorc_receptionist_review_items (reviewed_by_member_id)
  where reviewed_by_member_id is not null;

create index if not exists rorc_receptionist_eval_cases_creator_idx
  on public.rorc_receptionist_eval_cases (created_by_member_id)
  where created_by_member_id is not null;
