-- State + county demographics (reference data, refreshed ~yearly by
-- md-investment-pipeline/scripts/census_demographics.py). Lives beside
-- private_investment.geographies; published to the site via a md_dashboard view.
create table if not exists private_investment.census_demographics (
  fips text primary key,                       -- 2-digit state or 5-digit county FIPS
  geo_level text not null check (geo_level in ('state', 'county')),
  state_abbr text not null,
  name text not null,                          -- Census name, e.g. 'Baltimore city, Maryland'
  population integer,                          -- ACS 5-year B01003
  median_household_income integer,             -- ACS 5-year B19013, dollars
  poverty_rate numeric(5,1),                   -- ACS 5-year B17001, % of poverty universe
  labor_force integer,                         -- BLS LAUS annual average
  unemployed integer,                          -- BLS LAUS annual average
  unemployment_rate numeric(5,1),              -- unemployed / labor_force, %
  acs_release text not null,                   -- e.g. '2020-2024 ACS 5-year'
  laus_year integer not null,                  -- e.g. 2025
  loaded_at timestamptz not null default now()
);
alter table private_investment.census_demographics enable row level security;
comment on table private_investment.census_demographics is 'Census ACS 5-year population/income/poverty + BLS LAUS annual unemployment, per state and county. Loaded from scripts/census_demographics.py output.';

create or replace view md_dashboard.demographics with (security_invoker = false) as
select
  d.fips,
  d.geo_level as "geoLevel",
  d.state_abbr as state,
  d.name,
  -- County name as the investment records spell it (Maryland), so records and
  -- demographics join on county; other states keep the Census name minus state.
  case
    when d.geo_level = 'state' then null
    when d.name = 'Baltimore County, Maryland' then 'Baltimore County'
    when d.name = 'Baltimore city, Maryland' then 'Baltimore City'
    when d.state_abbr = 'MD' then regexp_replace(d.name, ' County, Maryland$', '')
    else regexp_replace(d.name, ', [^,]+$', '')
  end as county,
  d.population,
  d.median_household_income as "medianHouseholdIncome",
  d.poverty_rate::float8 as "povertyRate",
  d.unemployment_rate::float8 as "unemploymentRate",
  d.acs_release as "acsRelease",
  d.laus_year as "lausYear"
from private_investment.census_demographics d;

comment on view md_dashboard.demographics is 'Published state/county demographics for the dashboard site and Ask the Ledger.';
grant select on md_dashboard.demographics to anon, authenticated;
