-- Phase 3. Run after migrations 001–004 in Supabase. No existing archive rows are removed.
begin;
create table if not exists hs_bookmarks (
 owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 document_id uuid not null references hs_documents(id) on delete cascade, created_at timestamptz not null default now(),
 primary key(owner_id,document_id)
);
create table if not exists hs_reading_state (
 owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 document_id uuid not null references hs_documents(id) on delete cascade, read_at timestamptz not null default now(),
 primary key(owner_id,document_id)
);
create table if not exists hs_collections (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 name text not null check(length(trim(name)) between 1 and 80), created_at timestamptz not null default now(),
 unique(id,owner_id)
);
create table if not exists hs_collection_items (
 owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 collection_id uuid not null, document_id uuid not null references hs_documents(id) on delete cascade,
 added_at timestamptz not null default now(), primary key(collection_id,document_id),
 foreign key(collection_id,owner_id) references hs_collections(id,owner_id) on delete cascade
);
create table if not exists hs_notes (
 owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 document_id uuid not null references hs_documents(id) on delete cascade,
 body text not null check(length(body) between 1 and 5000), updated_at timestamptz not null default now(),
 primary key(owner_id,document_id)
);
create table if not exists hs_publication_events (
 id bigint generated always as identity primary key, document_id uuid not null references hs_documents(id) on delete cascade,
 revision_id uuid not null references hs_revisions(id) on delete cascade,
 kind text not null check(kind in ('published','updated')), historical boolean not null,
 created_at timestamptz not null default now(), unique(document_id,revision_id)
);
create table if not exists hs_saved_searches (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 name text not null check(length(trim(name)) between 1 and 80), query_text text not null default '' check(length(query_text)<=300),
 filters jsonb not null default '{}' check(jsonb_typeof(filters)='object' and length(filters::text)<=2000),
 groups jsonb not null default '[]' check(jsonb_typeof(groups)='array' and jsonb_array_length(groups)<=20 and length(groups::text)<=10000),
 mode text not null default 'keyword' check(mode in ('keyword','hybrid')),
 query_vector extensions.vector(384), model_id text references hs_embedding_models(id),
 threshold real not null default 0.6 check(threshold between 0.35 and 0.95),
 include_history boolean not null default false, include_updates boolean not null default false, enabled boolean not null default true,
 last_event_id bigint not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(length(trim(query_text))>0 or filters<>'{}'),
 check(mode='keyword' or (query_vector is not null and model_id is not null and extensions.vector_norm(query_vector) between 0.9 and 1.1)),
 unique(id,owner_id)
);
create table if not exists hs_notifications (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 search_id uuid not null, document_id uuid not null references hs_documents(id) on delete cascade,
 revision_id uuid not null references hs_revisions(id) on delete cascade,
 kind text not null check(kind in ('published','updated')), reason text not null, created_at timestamptz not null default now(), read_at timestamptz,
 foreign key(search_id,owner_id) references hs_saved_searches(id,owner_id) on delete cascade,
 unique(search_id,document_id,revision_id)
);
create index if not exists hs_notifications_owner_date on hs_notifications(owner_id,created_at desc);
create table if not exists hs_alert_pending (
 search_id uuid not null references hs_saved_searches(id) on delete cascade,
 event_id bigint not null references hs_publication_events(id) on delete cascade,
 primary key(search_id,event_id)
);
create table if not exists hs_feed_tokens (
 owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 search_id uuid primary key, token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 foreign key(search_id,owner_id) references hs_saved_searches(id,owner_id) on delete cascade
);

create or replace function hs_record_publication() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.current_revision_id is not null and new.current_revision_id is distinct from old.current_revision_id and new.status='published' then
  insert into hs_publication_events(document_id,revision_id,kind,historical)
  values(new.id,new.current_revision_id,case when old.current_revision_id is null then 'published' else 'updated' end,
   new.published_at is null or new.published_at < now()-interval '7 days') on conflict do nothing;
 end if; return new;
end $$;
drop trigger if exists hs_publication_event on hs_documents;
create trigger hs_publication_event after update of current_revision_id on hs_documents for each row execute function hs_record_publication();

create or replace function hs_personal_quota() returns trigger language plpgsql set search_path=public as $$
declare maximum integer; used integer;
begin
 perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text,0));
 maximum:=case tg_table_name when 'hs_collections' then 50 when 'hs_saved_searches' then 20 else 10000 end;
 execute format('select count(*) from public.%I where owner_id=$1',tg_table_name) into used using new.owner_id;
 if used>=maximum then raise exception 'Personal collection limit reached' using errcode='23514';end if;return new;
end $$;
drop trigger if exists hs_collection_quota on hs_collections;
create trigger hs_collection_quota before insert on hs_collections for each row execute function hs_personal_quota();
drop trigger if exists hs_search_quota on hs_saved_searches;
create trigger hs_search_quota before insert on hs_saved_searches for each row execute function hs_personal_quota();

create or replace function hs_clear_pending_search() returns trigger language plpgsql security definer set search_path=public as $$
begin delete from hs_alert_pending where search_id=new.id;return new;end $$;
drop trigger if exists hs_clear_pending_search on hs_saved_searches;
create trigger hs_clear_pending_search after update of query_text,filters,groups,mode,query_vector on hs_saved_searches for each row execute function hs_clear_pending_search();

create or replace function hs_require_user() returns uuid language plpgsql stable set search_path=public as $$
declare u uuid:=auth.uid(); begin if u is null then raise exception 'Sign-in required' using errcode='28000';end if;return u;end $$;

-- Personal functions run as the caller. RLS remains authoritative even for direct RPC calls.
create or replace function hs_me_mutate(p jsonb) returns jsonb language plpgsql set search_path=public,extensions as $$
declare u uuid:=hs_require_user(); a text:=p->>'action'; doc uuid; collection uuid; v_search uuid; changed integer;
begin
 if a in ('bookmark','reading','note','collection_item') then
  doc:=(p->>'documentId')::uuid;
  if not exists(select 1 from hs_documents where id=doc and status='published') then raise exception 'Document unavailable' using errcode='P0002';end if;
 end if;
 if a='bookmark' then
  if (p->>'saved')::boolean then insert into hs_bookmarks(owner_id,document_id) values(u,doc) on conflict do nothing;
  else delete from hs_bookmarks where owner_id=u and document_id=doc;end if;
 elsif a='reading' then
  if (p->>'read')::boolean then insert into hs_reading_state(owner_id,document_id) values(u,doc) on conflict(owner_id,document_id) do update set read_at=now();
  else delete from hs_reading_state where owner_id=u and document_id=doc;end if;
 elsif a='note' then
  if trim(coalesce(p->>'body',''))='' then delete from hs_notes where owner_id=u and document_id=doc;
  else insert into hs_notes(owner_id,document_id,body) values(u,doc,p->>'body') on conflict(owner_id,document_id) do update set body=excluded.body,updated_at=now();end if;
 elsif a='collection_create' then
  insert into hs_collections(owner_id,name) values(u,trim(p->>'name')) returning id into collection;return jsonb_build_object('id',collection);
 elsif a='collection_rename' then
  update hs_collections set name=trim(p->>'name') where id=(p->>'id')::uuid and owner_id=u;
  get diagnostics changed=row_count;if changed=0 then raise exception 'Collection not found' using errcode='P0002';end if;
 elsif a='collection_delete' then
  delete from hs_collections where id=(p->>'id')::uuid and owner_id=u;
  get diagnostics changed=row_count;if changed=0 then raise exception 'Collection not found' using errcode='P0002';end if;
 elsif a='collection_item' then
  collection:=(p->>'collectionId')::uuid;
  if not exists(select 1 from hs_collections where id=collection and owner_id=u) then raise exception 'Collection not found' using errcode='P0002';end if;
  if (p->>'present')::boolean then insert into hs_collection_items(owner_id,collection_id,document_id) values(u,collection,doc) on conflict do nothing;
  else delete from hs_collection_items where owner_id=u and collection_id=collection and document_id=doc;end if;
 elsif a='search_save' then
  v_search:=coalesce(nullif(p->>'id','')::uuid,gen_random_uuid());
  if p ? 'id' and not exists(select 1 from hs_saved_searches where id=v_search and owner_id=u) then raise exception 'Saved search not found' using errcode='P0002';end if;
  if p ? 'id' then
   update hs_saved_searches set name=trim(p->>'name'),query_text=coalesce(p->>'queryText',''),filters=coalesce(p->'filters','{}'),groups=coalesce(p->'groups','[]'),
    mode=coalesce(p->>'mode','keyword'),query_vector=case when p->>'mode'='hybrid' then (p->'vector')::text::extensions.vector(384) else null end,
    model_id=case when p->>'mode'='hybrid' then p->>'modelId' else null end,threshold=coalesce((p->>'threshold')::real,0.6),
    include_history=coalesce((p->>'includeHistory')::boolean,false),include_updates=coalesce((p->>'includeUpdates')::boolean,false),updated_at=now(),
    last_event_id=hs_event_watermark() where id=v_search and owner_id=u;
  else
   insert into hs_saved_searches(id,owner_id,name,query_text,filters,groups,mode,query_vector,model_id,threshold,include_history,include_updates,last_event_id)
   values(v_search,u,trim(p->>'name'),coalesce(p->>'queryText',''),coalesce(p->'filters','{}'),coalesce(p->'groups','[]'),coalesce(p->>'mode','keyword'),
    case when p->>'mode'='hybrid' then (p->'vector')::text::extensions.vector(384) else null end,
    case when p->>'mode'='hybrid' then p->>'modelId' else null end,coalesce((p->>'threshold')::real,0.6),coalesce((p->>'includeHistory')::boolean,false),
    coalesce((p->>'includeUpdates')::boolean,false),hs_event_watermark());
  end if;return jsonb_build_object('id',v_search);
 elsif a='search_toggle' then
  update hs_saved_searches set enabled=(p->>'enabled')::boolean,updated_at=now() where id=(p->>'id')::uuid and owner_id=u;
  get diagnostics changed=row_count;if changed=0 then raise exception 'Saved search not found' using errcode='P0002';end if;
 elsif a='search_options' then
  update hs_saved_searches set threshold=coalesce((p->>'threshold')::real,threshold),include_history=coalesce((p->>'includeHistory')::boolean,include_history),
   include_updates=coalesce((p->>'includeUpdates')::boolean,include_updates),updated_at=now() where id=(p->>'id')::uuid and owner_id=u;
  get diagnostics changed=row_count;if changed=0 then raise exception 'Saved search not found' using errcode='P0002';end if;
 elsif a='search_delete' then
  delete from hs_saved_searches where id=(p->>'id')::uuid and owner_id=u;
  get diagnostics changed=row_count;if changed=0 then raise exception 'Saved search not found' using errcode='P0002';end if;
 elsif a='notification_read' then
  update hs_notifications set read_at=case when (p->>'read')::boolean then now() else null end where id=(p->>'id')::uuid and owner_id=u;
 elsif a='feed_rotate' then
  v_search:=(p->>'searchId')::uuid;
  if not exists(select 1 from hs_saved_searches where id=v_search and owner_id=u) then raise exception 'Saved search not found' using errcode='P0002';end if;
  insert into hs_feed_tokens(owner_id,search_id,token_hash) values(u,v_search,p->>'tokenHash')
  on conflict(search_id) do update set token_hash=excluded.token_hash,created_at=now();
 elsif a='feed_revoke' then delete from hs_feed_tokens where search_id=(p->>'searchId')::uuid and owner_id=u;
 else raise exception 'Unknown personal operation' using errcode='22023';end if;
 return jsonb_build_object('ok',true);
end $$;

create or replace function hs_me_annotations(p jsonb) returns jsonb language plpgsql stable set search_path=public as $$
declare u uuid:=hs_require_user(); result jsonb;
begin
 select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'saved',exists(select 1 from hs_bookmarks where owner_id=u and document_id=d.id),
 'read',exists(select 1 from hs_reading_state where owner_id=u and document_id=d.id),'hasNote',exists(select 1 from hs_notes where owner_id=u and document_id=d.id))),'[]') into result
 from hs_documents d where d.id in(select value::uuid from jsonb_array_elements_text(p->'ids') limit 50) and d.status='published';return result;
end $$;
create or replace function hs_me_document(p jsonb) returns jsonb language plpgsql stable set search_path=public as $$
declare u uuid:=hs_require_user(); doc uuid:=(p->>'id')::uuid;
begin return jsonb_build_object('saved',exists(select 1 from hs_bookmarks where owner_id=u and document_id=doc),
 'read',exists(select 1 from hs_reading_state where owner_id=u and document_id=doc),
 'note',coalesce((select body from hs_notes where owner_id=u and document_id=doc),''),
 'collections',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'contains',exists(select 1 from hs_collection_items i where i.owner_id=u and i.collection_id=c.id and i.document_id=doc))) from hs_collections c where owner_id=u),'[]'));
end $$;
create or replace function hs_me_library(p jsonb default '{}') returns jsonb language plpgsql stable set search_path=public as $$
declare u uuid:=hs_require_user(); result jsonb;
begin
 with entries as (
  select document_id from hs_bookmarks where owner_id=u
  union select document_id from hs_notes where owner_id=u
  union select document_id from hs_reading_state where owner_id=u
  union select document_id from hs_collection_items where owner_id=u
 ), filtered as (
  select e.document_id,d.title,d.canonical_url,d.kind,d.platform,d.completeness,d.published_at,
   b.created_at as bookmarked_at,n.body as note,r.read_at
  from entries e left join hs_documents d on d.id=e.document_id and d.status='published'
  left join hs_bookmarks b on b.document_id=e.document_id and b.owner_id=u
  left join hs_notes n on n.document_id=e.document_id and n.owner_id=u
  left join hs_reading_state r on r.document_id=e.document_id and r.owner_id=u
  where (coalesce(p->>'tab','bookmarks')<>'bookmarks' or b.document_id is not null)
   and (coalesce(p->>'tab','')<>'notes' or n.document_id is not null)
   and (coalesce(p->>'tab','')<>'read' or r.document_id is not null)
   and (coalesce(p->>'tab','')<>'unread' or (b.document_id is not null and r.document_id is null))
   and (nullif(p->>'collectionId','') is null or exists(select 1 from hs_collection_items i where i.owner_id=u and i.collection_id=(p->>'collectionId')::uuid and i.document_id=e.document_id))
 ), page as (
  select * from filtered order by bookmarked_at desc nulls last,document_id limit 50 offset (greatest(coalesce((p->>'page')::int,1),1)-1)*50
 ) select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(page)) from page),'[]'),'total',(select count(*) from filtered),
 'collections',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'count',(select count(*) from hs_collection_items i where i.collection_id=c.id and i.owner_id=u))) from hs_collections c where c.owner_id=u),'[]')) into result;return result;
end $$;
create or replace function hs_me_searches(p jsonb default '{}') returns jsonb language plpgsql stable set search_path=public as $$
declare u uuid:=hs_require_user(); result jsonb;
begin select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'queryText',s.query_text,'filters',s.filters,'mode',s.mode,'threshold',s.threshold,
 'includeHistory',s.include_history,'includeUpdates',s.include_updates,'enabled',s.enabled,'createdAt',s.created_at,'feedEnabled',exists(select 1 from hs_feed_tokens f where f.search_id=s.id and f.owner_id=u)) order by s.created_at desc),'[]') into result from hs_saved_searches s where s.owner_id=u;return result;end $$;
create or replace function hs_me_notifications(p jsonb default '{}') returns jsonb language plpgsql stable set search_path=public as $$
declare u uuid:=hs_require_user(); result jsonb;
begin select jsonb_build_object('unread',(select count(*) from hs_notifications where owner_id=u and read_at is null),
 'items',coalesce((select jsonb_agg(x) from (select n.id,n.document_id,n.kind,n.reason,n.created_at,n.read_at,d.title,d.canonical_url,s.name as search_name
 from hs_notifications n join hs_saved_searches s on s.id=n.search_id and s.owner_id=u
 left join hs_documents d on d.id=n.document_id and d.status='published'
 where n.owner_id=u order by n.created_at desc,n.id limit 50 offset (greatest(coalesce((p->>'page')::int,1),1)-1)*50) x),'[]')) into result;return result;end $$;
create or replace function hs_me_export(p jsonb default '{}') returns jsonb language plpgsql stable set search_path=public as $$
declare u uuid:=hs_require_user();begin return jsonb_build_object('formatVersion',1,'exportedAt',now(),
 'bookmarks',coalesce((select jsonb_agg(to_jsonb(b)||jsonb_build_object('title',d.title,'originalUrl',d.canonical_url)) from hs_bookmarks b left join hs_documents d on d.id=b.document_id where b.owner_id=u),'[]'),
 'readingState',coalesce((select jsonb_agg(r) from hs_reading_state r where owner_id=u),'[]'),
 'collections',coalesce((select jsonb_agg(c) from hs_collections c where owner_id=u),'[]'),
 'collectionItems',coalesce((select jsonb_agg(i) from hs_collection_items i where owner_id=u),'[]'),
 'notes',coalesce((select jsonb_agg(n) from hs_notes n where owner_id=u),'[]'),
 'savedSearches',hs_me_searches('{}'),
 'notifications',coalesce((select jsonb_agg(n) from hs_notifications n where owner_id=u),'[]'));
end $$;

-- Feed resolution uses only a hashed bearer token and returns public document metadata.
create or replace function hs_feed_resolve(p jsonb) returns jsonb language sql stable set search_path=public as $$
 select jsonb_build_object('name',s.name,'items',coalesce((select jsonb_agg(x) from (
  select n.id,n.created_at,d.title,d.canonical_url,d.excerpt from hs_notifications n join hs_documents d on d.id=n.document_id and d.status='published'
  where n.search_id=s.id and n.owner_id=s.owner_id order by n.created_at desc,n.id limit 50) x),'[]'))
 from hs_feed_tokens t join hs_saved_searches s on s.id=t.search_id and s.owner_id=t.owner_id where t.token_hash=p->>'tokenHash' and s.enabled;
$$;

create or replace function hs_event_matches(s hs_saved_searches,e hs_publication_events) returns text
language plpgsql stable set search_path=public,extensions set jit=off as $$
declare d hs_documents; keyword_match boolean; score real;
begin
 select * into d from hs_documents where id=e.document_id and status='published' and current_revision_id=e.revision_id;
 if not found then return 'skip';end if;
 if e.historical and not s.include_history then return 'skip';end if;
 if e.kind='updated' and not s.include_updates then return 'skip';end if;
 if (coalesce(s.filters->>'kind','')<>'' and d.kind<>s.filters->>'kind')
 or (coalesce(s.filters->>'source','')<>'' and d.platform<>s.filters->>'source')
 or (coalesce(s.filters->>'topic','')<>'' and not s.filters->>'topic'=any(d.topics))
 or (coalesce(s.filters->>'author','')<>'' and not s.filters->>'author'=any(d.authors))
 or (coalesce(s.filters->>'completeness','')<>'' and d.completeness<>s.filters->>'completeness')
 or (nullif(s.filters->>'after','') is not null and (d.published_at is null or d.published_at<(s.filters->>'after')::date))
 or (nullif(s.filters->>'before','') is not null and (d.published_at is null or d.published_at>=(s.filters->>'before')::date+interval '1 day')) then return 'skip';end if;
 if jsonb_array_length(s.groups)=0 then keyword_match:=s.filters<>'{}';
 else select not exists(select 1 from jsonb_array_elements(s.groups) as g(value) where not exists(select 1 from hs_chunks c where c.document_id=d.id and c.fts @@ hs_query_group(g.value))) into keyword_match;end if;
 if keyword_match then return 'Keyword or followed-filter match';end if;
 if s.mode='hybrid' then
  if not exists(select 1 from hs_embedding_sets x where x.document_id=d.id and x.revision_id=d.current_revision_id and x.model_id=s.model_id) then return 'pending';end if;
  select max(1-(embedding<=>s.query_vector)) into score from hs_embedding_passages where document_id=d.id and revision_id=d.current_revision_id and model_id=s.model_id;
  if score>=s.threshold then return 'Semantic match';end if;
 end if;return 'skip';
end $$;

create or replace function hs_alert_run(p jsonb default '{}') returns jsonb
language plpgsql set search_path=public,extensions set jit=off as $$
declare s hs_saved_searches; e hs_publication_events; decision text; n integer; created integer:=0; checked integer:=0; searches integer:=0; last_search uuid; event_max bigint;
begin
 -- Serialize processors; retries cannot race notification deduplication or watermarks.
 if not pg_try_advisory_xact_lock(817263510) then return jsonb_build_object('busy',true,'created',0);end if;
 for s in select * from hs_saved_searches where enabled and (nullif(p->>'afterSearchId','') is null or id>(p->>'afterSearchId')::uuid) order by id limit 25 loop
  searches:=searches+1;last_search:=s.id;event_max:=s.last_event_id;
  for e in select ev.* from hs_publication_events ev where ev.id in (
   (select id from hs_publication_events where id>s.last_event_id order by id limit 40)
   union
   (select w.event_id from hs_alert_pending w join hs_publication_events pending_event on pending_event.id=w.event_id
    where w.search_id=s.id order by exists(select 1 from hs_embedding_sets x where x.document_id=pending_event.document_id and x.revision_id=pending_event.revision_id and x.model_id=s.model_id) desc,w.event_id limit 10)
  ) order by ev.id loop
   checked:=checked+1;decision:=hs_event_matches(s,e);event_max:=greatest(event_max,e.id);
   if decision='pending' then insert into hs_alert_pending(search_id,event_id) values(s.id,e.id) on conflict do nothing;
   else
    delete from hs_alert_pending where search_id=s.id and event_id=e.id;
    if decision<>'skip' then
     insert into hs_notifications(owner_id,search_id,document_id,revision_id,kind,reason) values(s.owner_id,s.id,e.document_id,e.revision_id,e.kind,decision) on conflict do nothing;
     get diagnostics n=row_count;created:=created+n;
    end if;
   end if;
  end loop;
  update hs_saved_searches set last_event_id=event_max where id=s.id;
 end loop;
 return jsonb_build_object('processedSearches',searches,'checkedEvents',checked,'created',created,'afterSearchId',case when searches=25 then last_search else null end);
end $$;
create or replace function hs_phase3_status(p jsonb default '{}') returns jsonb language sql stable as $$select jsonb_build_object('phase',3);$$;

-- Direct personal-table access is also protected: changing the HTTP client cannot bypass ownership.
do $$ declare table_name text; routine record; begin
 foreach table_name in array array['hs_bookmarks','hs_reading_state','hs_collections','hs_collection_items','hs_notes','hs_saved_searches','hs_notifications','hs_feed_tokens'] loop
  execute format('alter table public.%I enable row level security',table_name);
  execute format('revoke all on table public.%I from public,anon,authenticated',table_name);
  execute format('grant select on table public.%I to authenticated',table_name);
  if table_name<>'hs_notifications' then execute format('grant insert,update,delete on table public.%I to authenticated',table_name);end if;
  execute format('grant all on table public.%I to service_role',table_name);
  execute format('drop policy if exists hs_own_rows on public.%I',table_name);
  execute format('create policy hs_own_rows on public.%I for all to authenticated using (owner_id=(select auth.uid())) with check (owner_id=(select auth.uid()))',table_name);
 end loop;
 grant update(read_at) on hs_notifications to authenticated;
 alter table hs_publication_events enable row level security;
 alter table hs_alert_pending enable row level security;
 revoke all on hs_publication_events,hs_alert_pending from public,anon,authenticated;
 grant all on hs_publication_events,hs_alert_pending to service_role;
 grant usage,select on sequence hs_publication_events_id_seq to service_role;
 for routine in select p.oid::regprocedure as signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'hs_me\_%' escape '\' or p.proname in ('hs_require_user','hs_record_publication','hs_personal_quota','hs_clear_pending_search','hs_feed_resolve','hs_event_matches','hs_alert_run','hs_phase3_status')) loop
  execute format('revoke all on function %s from public,anon,authenticated',routine.signature);
  execute format('grant execute on function %s to service_role',routine.signature);
  if routine.proname like 'hs_me\_%' escape '\' or routine.proname in ('hs_require_user','hs_personal_quota') then execute format('grant execute on function %s to authenticated',routine.signature);end if;
 end loop;
end $$;

-- Authenticated library joins can read only published, non-sensitive catalog columns.
grant select(id,title,canonical_url,kind,platform,authors,topics,published_at,completeness,status) on hs_documents to authenticated;
grant usage on schema extensions to authenticated;
drop policy if exists hs_personal_catalog_read on hs_documents;
create policy hs_personal_catalog_read on hs_documents for select to authenticated using(status='published');

-- Watermark access does not expose event contents or run with user-supplied SQL.
create or replace function hs_event_watermark() returns bigint language sql stable security definer set search_path=public as $$select coalesce(max(id),0) from hs_publication_events;$$;
revoke all on function hs_event_watermark() from public,anon;
grant execute on function hs_event_watermark() to authenticated,service_role;
commit;
