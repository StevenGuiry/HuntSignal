-- Phase 5: source registration, explicit preservation coverage and four-hour feeds.
begin;
create or replace function hs_ops_register_source(p jsonb) returns jsonb language plpgsql set search_path=public as $$
declare sid text:=p->>'id';seconds integer:=(p->>'pollSeconds')::integer;
begin
 if sid is null or sid !~ '^[a-z0-9-]{1,60}$' or length(coalesce(p->>'name','')) not between 1 and 100 or coalesce(p->>'url','') !~ '^https://' or seconds is null or seconds not between 14400 and 2592000 then raise exception 'Invalid source configuration';end if;
 insert into hs_sources(id,name,url) values(sid,p->>'name',p->>'url') on conflict(id) do update set name=excluded.name,url=excluded.url;
 insert into hs_source_control(source_id,poll_seconds) values(sid,seconds) on conflict(source_id) do update set poll_seconds=excluded.poll_seconds;
 return jsonb_build_object('ok',true);
end $$;
revoke all on function hs_ops_register_source(jsonb) from public,anon,authenticated;
grant execute on function hs_ops_register_source(jsonb) to service_role;
update hs_source_control set poll_seconds=14400 where source_id='hackerone';

create or replace function hs_sources_list(p jsonb default '{}') returns jsonb language sql stable set search_path=public as $$
 select coalesce(jsonb_agg(x),'[]') from (select s.*,
 (select count(*) from hs_documents where source_id=s.id and status='published') as documents,
 (select count(*) from hs_documents where source_id=s.id and status='published' and completeness='full') as full,
 (select count(*) from hs_documents where source_id=s.id and status='published' and completeness='partial') as partial,
 (select count(*) from hs_documents where source_id=s.id and status='published' and completeness='metadata') as metadata,
 (select count(*) from hs_documents where source_id=s.id and status='published' and kind='paper') as papers
 from hs_sources s order by s.name) x;
$$;
create or replace function hs_stats(p jsonb default '{}') returns jsonb language sql stable set search_path=public as $$
 select jsonb_build_object('total',count(*),'full',count(*) filter(where completeness='full'),'partial',count(*) filter(where completeness='partial'),'metadata',count(*) filter(where completeness='metadata'),'papers',count(*) filter(where kind='paper'),'reports',count(*) filter(where kind='report'),'articles',count(*) filter(where kind in ('article','paper')),
 'sources',count(distinct platform),'feed_sources',count(distinct source_id),'last_ingested_at',max(updated_at),'oldest',min(published_at),'newest',max(published_at),
 'topics',(select coalesce(jsonb_agg(t),'[]') from (select topic,count(*) from hs_documents cross join lateral unnest(topics) as topic where status='published' group by topic order by count(*) desc limit 20) t),
 'platforms',(select coalesce(jsonb_agg(s),'[]') from (select platform,count(*) from hs_documents where status='published' group by platform order by count(*) desc) s)) from hs_documents where status='published';
$$;
-- No durable table shape changed: encrypted snapshots remain schema version 9.
commit;
