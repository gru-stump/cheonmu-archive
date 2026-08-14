begin;

select plan(3);

select has_table('public', 'drafts', 'drafts exists');
select policies_are('public', 'drafts', array['owner can manage drafts']);
select throws_ok(
  $$ select transition_draft(gen_random_uuid(), 'generated', 'published') $$,
  'P0001',
  'illegal draft transition'
);

select * from finish();

rollback;
