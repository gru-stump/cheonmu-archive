-- GPT-5 mini Responses usage includes both visible text and reasoning tokens.
-- Successful short-dialogue generations already consume about 3.4k-3.6k
-- output tokens, so the former 4k application ceiling was not reliable.
update public.provider_settings
set max_output_tokens = 8000,
    updated_at = pg_catalog.clock_timestamp()
where provider_key = 'openai'
  and model_key = 'gpt-5-mini'
  and max_input_tokens = 4000
  and max_output_tokens = 4000
  and max_revision_output_tokens = 2000;
