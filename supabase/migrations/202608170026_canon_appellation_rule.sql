-- Keep Muyeong's title for Cheonryeong explicit in every owner's immutable canon.
-- Existing owners receive the rule once; fresh local fixtures receive the same
-- rule from seed.sql because seeds run after migrations.
insert into public.memory_items (
  owner_id,
  memory_type,
  content,
  importance,
  metadata,
  status,
  blocking
)
select
  profile.owner_id,
  'canon',
  '무영은 관계 단계와 무관하게 천령을 ''천령 의료관님''이라고 부른다. 대화의 맥락이 분명할 때는 ''의료관님''으로 줄여 부른다. ''천령 선생''과 ''선생님''은 사용하지 않는다. 감정이 크게 흔들릴 때만 ''천령''이라고 부른다.',
  100,
  jsonb_build_object(
    'canonKey', 'muyeong-cheonryeong-appellation-v1',
    'tokenCount', 70,
    'continuityFacts', jsonb_build_object(
      'relationshipStage', 7,
      'voiceAndTitleRules', true
    )
  ),
  'approved',
  false
from public.owner_profiles as profile
where not exists (
  select 1
  from public.memory_items as memory
  where memory.owner_id = profile.owner_id
    and memory.metadata ->> 'canonKey' = 'muyeong-cheonryeong-appellation-v1'
);
