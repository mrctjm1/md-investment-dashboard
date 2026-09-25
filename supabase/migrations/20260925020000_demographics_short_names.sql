-- County names are stored without the ", State" suffix (state is its own
-- column), so the dataset-naming rules no longer strip it.
comment on column private_investment.census_demographics.name is 'State name, or county name without the state suffix (e.g. ''Baltimore city'')';

create or replace view md_dashboard.demographics with (security_invoker = false) as
select
  d.fips,
  d.geo_level as "geoLevel",
  d.state_abbr as state,
  d.name,
  -- County name as the investment records spell it (Maryland), so records and
  -- demographics join on county; other states keep the Census county name.
  case
    when d.geo_level = 'state' then null
    when d.state_abbr = 'MD' and d.name = 'Baltimore city' then 'Baltimore City'
    when d.state_abbr = 'MD' and d.name = 'Baltimore County' then 'Baltimore County'
    when d.state_abbr = 'MD' then regexp_replace(d.name, ' County$', '')
    else d.name
  end as county,
  d.population,
  d.median_household_income as "medianHouseholdIncome",
  d.poverty_rate::float8 as "povertyRate",
  d.unemployment_rate::float8 as "unemploymentRate",
  d.acs_release as "acsRelease",
  d.laus_year as "lausYear"
from private_investment.census_demographics d;
