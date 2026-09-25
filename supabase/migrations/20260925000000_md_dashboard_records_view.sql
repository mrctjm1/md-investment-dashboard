-- Public, read-only surface for the MD investment dashboard website.
-- Holds nothing but this one view, so exposing the schema through the Data API
-- can never reveal pipeline tables (private_investment / public_investment).
-- The view runs with its owner's rights (security_invoker = false) on purpose:
-- visitors (anon) get SELECT on this curated view only -- never on the raw
-- tables -- and the view itself enforces the published = true gate.
create schema if not exists md_dashboard;
comment on schema md_dashboard is 'Read-only public API surface for the MD investment dashboard. Only views over published records belong here.';

create or replace view md_dashboard.records with (security_invoker = false) as
with priv as (
  select
    i.id, 'private_investment'::text as type,
    e.canonical_name as company, i.name,
    i.sector_category as category, 'sector'::text as "categoryKind", i.sector as "sectorLabel",
    i.record_type as "recordType",
    null::text as "awardingLevel", null::text as "fundingMechanism", null::text as "awardingAgency",
    null::text as "programName", null::int as "fiscalYear",
    i.completion_stage as "completionStage",
    i.amount_usd::float8 as amount, i.amount_confidence as confidence, i.amount_note as "amountNote",
    i.jobs_new as "jobsNew", i.jobs_retained as "jobsRetained", i.jobs_construction as "jobsConstruction", i.jobs_note as "jobsNote",
    i.status, i.status_note as "statusNote",
    i.date_announced as "dateAnnounced", i.date_status_asof as "dateStatusAsof",
    g.county, g.place, case when g.state = 'Maryland' then 'MD' else g.state end as state, i.address,
    coalesce(i.facility_lat, g.lat)::float8 as lat, coalesce(i.facility_lon, g.lon)::float8 as lon,
    case when i.facility_lat is not null then 'address'
         when g.place is not null then 'place_centroid_fallback_county'
         else 'county_centroid' end as "geoPrecision",
    case when i.facility_lat is not null then 'precise'
         when g.county = 'Maryland (county unspecified)' then 'state'
         else 'county' end as "geoLevel",
    i.is_volatile as "isVolatile",
    src.names as "sourceNames", src.urls as "sourceUrls",
    null::uuid as "relatedPrivateId",
    i.name || ' in ' || coalesce(g.place, g.county)
      || coalesce(' (' || replace(i.completion_stage, '_', ' ') || ')', '') as "oneSentence"
  from private_investment.investments i
  left join private_investment.entities e on e.id = i.entity_id
  left join private_investment.geographies g on g.id = i.geography_id
  left join lateral (
    select string_agg(s.name || ' (' || s.source_category || ')', '; ' order by s.name, x.source_url) as names,
           string_agg(x.source_url, ' | ' order by s.name, x.source_url) as urls
    from private_investment.investment_sources x
    join private_investment.sources s on s.id = x.source_id
    where x.investment_id = i.id
  ) src on true
  where i.published
),
pub as (
  select
    a.id, 'public_investment'::text,
    e.canonical_name, btrim(a.name),
    a.purpose_category, 'purpose'::text, null::text,
    null::text,
    a.awarding_level, a.funding_mechanism, a.awarding_agency,
    btrim(a.program_name), a.fiscal_year,
    a.completion_stage,
    a.amount_usd::float8, a.amount_confidence, a.amount_note,
    null::int, null::int, null::int, null::text,
    a.status, a.status_note,
    a.date_awarded, a.date_status_asof,
    g.county, g.place, case when g.state = 'Maryland' then 'MD' else g.state end, null::text,
    coalesce(a.facility_lat, g.lat)::float8, coalesce(a.facility_lon, g.lon)::float8,
    case when a.facility_lat is not null then 'address' else 'county_centroid' end,
    case when a.facility_lat is not null then 'precise'
         when g.county = 'Maryland (county unspecified)' then 'state'
         else 'county' end,
    false,
    src.names, src.urls,
    a.related_private_investment_id,
    btrim(a.name) || ' — ' || initcap(a.awarding_level) || ' ' || replace(a.funding_mechanism, '_', ' ')
  from public_investment.awards a
  left join private_investment.entities e on e.id = a.recipient_entity_id
  left join private_investment.geographies g on g.id = a.geography_id
  left join lateral (
    select string_agg(s.name || ' (' || s.source_category || ')', '; ' order by s.name, x.source_url) as names,
           string_agg(x.source_url, ' | ' order by s.name, x.source_url) as urls
    from public_investment.award_sources x
    join private_investment.sources s on s.id = x.source_id
    where x.award_id = a.id
  ) src on true
  where a.published
)
select * from priv union all select * from pub;

comment on view md_dashboard.records is 'One flat row per published record (private investments + public awards) in the exact shape index.html reads.';

grant usage on schema md_dashboard to anon, authenticated;
grant select on md_dashboard.records to anon, authenticated;
