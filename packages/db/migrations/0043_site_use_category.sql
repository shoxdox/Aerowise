-- What a site's system serves, where an authority's rules differ by it (Montgomery County
-- order 10(j): commercial and multifamily lab tests; its food establishment contract form).
-- Null means nobody has recorded it; nothing is guessed from the customer type.
alter table sites add column use_category text
  check (use_category in ('single_family', 'multifamily', 'commercial', 'food_establishment'));
