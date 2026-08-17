begin;

select plan(3);

select is(
  (
    select count(*)
    from public.memory_items
    where owner_id = '10000000-0000-0000-0000-000000000001'
      and memory_type = 'canon'
      and status = 'approved'
      and metadata ->> 'canonKey' = 'muyeong-cheonryeong-appellation-v1'
  ),
  1::bigint,
  'the owner has one approved canonical appellation rule'
);

select ok(
  exists (
    select 1
    from public.memory_items
    where owner_id = '10000000-0000-0000-0000-000000000001'
      and metadata ->> 'canonKey' = 'muyeong-cheonryeong-appellation-v1'
      and content like '%천령 의료관님%'
      and content like '%의료관님%'
  ),
  'the canonical rule tells Muyeong to use the medical-officer title'
);

select ok(
  exists (
    select 1
    from public.memory_items
    where owner_id = '10000000-0000-0000-0000-000000000001'
      and metadata ->> 'canonKey' = 'muyeong-cheonryeong-appellation-v1'
      and content like '%천령 선생%사용하지 않는다%'
      and content like '%선생님%사용하지 않는다%'
  ),
  'the canonical rule explicitly retires the teacher titles'
);

select * from finish();
rollback;
