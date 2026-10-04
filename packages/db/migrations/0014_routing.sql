-- Route optimization: where each site is on the map, where technicians start their day,
-- and the numbers a day's travel estimate is drawn from.

-- Where the coordinates came from. Coordinates typed in by a person are kept when the
-- address changes; coordinates found by the geocoder are dropped and found again.
alter table sites
  add column location_source text check (location_source in ('manual', 'geocoder')),
  -- The geocoder could not find this address. Cleared when the address changes.
  add column geocode_status text check (geocode_status in ('not_found')),
  add check ((lat is null) = (lng is null)),
  add check ((location_source is null) = (lat is null)),
  add check (geocode_status is null or lat is null);

update sites set location_source = 'manual' where lat is not null;

-- Sites the geocoder still has to look up.
create index sites_unlocated_idx on sites (organization_id) where lat is null and geocode_status is null and active;

alter table organizations
  -- Where technicians leave from in the morning (the yard or office). Optional.
  add column route_start_address text,
  add column route_start_lat double precision check (route_start_lat between -90 and 90),
  add column route_start_lng double precision check (route_start_lng between -180 and 180),
  -- Whether a day's route ends back at the start.
  add column route_return_to_start boolean not null default true,
  -- Average time on site per stop, length of a technician's day, and average driving speed.
  add column route_stop_minutes integer not null default 30 check (route_stop_minutes between 0 and 480),
  add column route_day_minutes integer not null default 480 check (route_day_minutes between 60 and 1440),
  add column route_speed_mph integer not null default 35 check (route_speed_mph between 5 and 80),
  add check ((route_start_lat is null) = (route_start_lng is null));
