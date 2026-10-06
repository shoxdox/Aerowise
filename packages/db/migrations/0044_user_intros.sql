-- The short introductions shown the first time someone opens the office screens or the
-- technician app (W10.4). Each person closes them once, wherever they sign in; they can
-- open them again from the same place.
alter table users add column intros_dismissed text[] not null default '{}';
