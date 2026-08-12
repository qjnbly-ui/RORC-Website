alter table public.rorc_receptionist_calls
  add column if not exists prompt_version text,
  add column if not exists router_model text,
  add column if not exists answer_model text;

create table if not exists public.rorc_receptionist_review_items (
  id uuid primary key default gen_random_uuid(),
  call_sid text not null references public.rorc_receptionist_calls(call_sid) on delete cascade,
  caller_utterance text not null,
  assistant_response text not null,
  review_reasons text[] not null default '{}',
  intent text,
  confidence numeric(5,4),
  route_source text,
  knowledge_version text,
  prompt_version text,
  router_model text,
  answer_model text,
  review_status text not null default 'pending',
  issue_category text,
  expected_behavior text,
  reviewed_by_member_id uuid references public.account_members(id) on delete set null,
  reviewed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rorc_receptionist_review_items_utterance_check check (
    btrim(caller_utterance) <> '' and length(caller_utterance) <= 800
  ),
  constraint rorc_receptionist_review_items_response_check check (
    btrim(assistant_response) <> '' and length(assistant_response) <= 2400
  ),
  constraint rorc_receptionist_review_items_reasons_check check (
    cardinality(review_reasons) > 0
    and review_reasons <@ array[
      'low_confidence', 'router_fallback', 'needs_clarification',
      'unresolved_answer', 'request_error'
    ]::text[]
  ),
  constraint rorc_receptionist_review_items_intent_check check (
    intent is null or intent in (
      'simple_question', 'detailed_explanation', 'send_information',
      'start_form', 'check_account', 'request_person'
    )
  ),
  constraint rorc_receptionist_review_items_confidence_check check (
    confidence is null or (confidence >= 0 and confidence <= 1)
  ),
  constraint rorc_receptionist_review_items_source_check check (
    route_source is null or route_source in ('model', 'fallback')
  ),
  constraint rorc_receptionist_review_items_status_check check (
    review_status in ('pending', 'dismissed', 'corrected')
  ),
  constraint rorc_receptionist_review_items_category_check check (
    issue_category is null or issue_category in (
      'correct', 'wrong_information', 'wrong_action',
      'confusing', 'unresolved', 'other'
    )
  )
);

create index if not exists rorc_receptionist_review_items_created_idx
  on public.rorc_receptionist_review_items (created_at desc);
create index if not exists rorc_receptionist_review_items_pending_idx
  on public.rorc_receptionist_review_items (created_at desc)
  where review_status = 'pending';
create index if not exists rorc_receptionist_review_items_expiry_idx
  on public.rorc_receptionist_review_items (expires_at);

create table if not exists public.rorc_receptionist_eval_cases (
  id uuid primary key default gen_random_uuid(),
  source_review_id uuid unique references public.rorc_receptionist_review_items(id) on delete set null,
  caller_utterance text not null,
  expected_behavior text not null,
  expected_intent text,
  required_phrases text[] not null default '{}',
  forbidden_phrases text[] not null default '{}',
  issue_category text not null,
  enabled boolean not null default true,
  created_by_member_id uuid references public.account_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rorc_receptionist_eval_cases_utterance_check check (
    btrim(caller_utterance) <> '' and length(caller_utterance) <= 800
  ),
  constraint rorc_receptionist_eval_cases_behavior_check check (
    btrim(expected_behavior) <> '' and length(expected_behavior) <= 2400
  ),
  constraint rorc_receptionist_eval_cases_intent_check check (
    expected_intent is null or expected_intent in (
      'simple_question', 'detailed_explanation', 'send_information',
      'start_form', 'check_account', 'request_person'
    )
  ),
  constraint rorc_receptionist_eval_cases_category_check check (
    issue_category in (
      'wrong_information', 'wrong_action', 'confusing', 'unresolved', 'other'
    )
  ),
  constraint rorc_receptionist_eval_cases_assertion_check check (
    expected_intent is not null
    or cardinality(required_phrases) > 0
    or cardinality(forbidden_phrases) > 0
  )
);

create index if not exists rorc_receptionist_eval_cases_enabled_idx
  on public.rorc_receptionist_eval_cases (created_at desc)
  where enabled = true;

drop trigger if exists rorc_receptionist_review_items_set_updated_at
  on public.rorc_receptionist_review_items;
create trigger rorc_receptionist_review_items_set_updated_at
before update on public.rorc_receptionist_review_items
for each row execute function public.set_updated_at();

drop trigger if exists rorc_receptionist_eval_cases_set_updated_at
  on public.rorc_receptionist_eval_cases;
create trigger rorc_receptionist_eval_cases_set_updated_at
before update on public.rorc_receptionist_eval_cases
for each row execute function public.set_updated_at();

alter table public.rorc_receptionist_review_items enable row level security;
alter table public.rorc_receptionist_eval_cases enable row level security;

revoke all on table public.rorc_receptionist_review_items from public, anon, authenticated;
revoke all on table public.rorc_receptionist_eval_cases from public, anon, authenticated;

grant select, insert, update, delete on table public.rorc_receptionist_review_items to service_role;
grant select, insert, update, delete on table public.rorc_receptionist_eval_cases to service_role;
