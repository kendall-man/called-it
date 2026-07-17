-- Staging seed: player entities for the mockline demo scripts.
-- Run AFTER migrations 0001+0002+0003 in the THROWAWAY staging Supabase
-- project (SQL editor → paste → run). Never against the live demo project.
--
-- Why this exists: the engine reads players/fixture_players for claim
-- grounding (prefilter dictionary + resolvePlayer), but nothing in the
-- codebase writes them — production seeds them out-of-band. Ids must match
-- apps/mockline/src/scripts/france-spain-20260714.ts (the REAL 2026-07-14
-- semifinal: France 0-2 Spain).

-- Fixture stubs so fixture_players FKs resolve; the engine's 15-min fixtures
-- sync upserts real kickoff times over these. 9001 = the boot replay match,
-- 9101-9130 = the /mock/schedule live-match id range.
insert into fixtures (fixture_id, p1_name, p2_name)
select fid, 'France', 'Spain'
from (
  select 9001 as fid
  union all
  select generate_series(9101, 9130)
) ids(fid)
on conflict (fixture_id) do nothing;

insert into players (normative_id, preferred_name, team, aliases) values
  -- France — real starting XI on 2026-07-14
  (7001, 'Kylian Mbappé',       'France', array['mbappe','mbappé','kylian','kyks']),
  (7003, 'Ousmane Dembélé',     'France', array['dembele','dembélé','ousmane']),
  (7004, 'Aurélien Tchouaméni', 'France', array['tchouameni','tchouaméni']),
  (7006, 'Adrien Rabiot',       'France', array['rabiot']),
  (7007, 'Michael Olise',       'France', array['olise']),
  (7008, 'Bradley Barcola',     'France', array['barcola']),
  (7009, 'Lucas Digne',         'France', array['digne']),
  (7010, 'Mike Maignan',        'France', array['maignan','mike']),
  (7011, 'William Saliba',      'France', array['saliba']),
  (7012, 'Dayot Upamecano',     'France', array['upamecano','upa']),
  (7013, 'Jules Koundé',        'France', array['kounde','koundé','jules']),
  -- France — substitutes used
  (7014, 'Désiré Doué',         'France', array['doue','doué','desire']),
  (7015, 'Rayan Cherki',        'France', array['cherki']),
  (7016, 'Manu Koné',           'France', array['kone','koné','manu']),
  (7017, 'Maxence Lacroix',     'France', array['lacroix']),
  -- Spain — real starting XI
  (7201, 'Lamine Yamal',        'Spain', array['yamal','lamine']),
  (7202, 'Mikel Oyarzabal',     'Spain', array['oyarzabal','mikel']),
  (7203, 'Pedro Porro',         'Spain', array['porro']),
  (7204, 'Dani Olmo',           'Spain', array['olmo','dani']),
  (7205, 'Rodri',               'Spain', array['rodri','rodrigo hernandez']),
  (7206, 'Fabián Ruiz',         'Spain', array['fabian','fabián','ruiz']),
  (7207, 'Álex Baena',          'Spain', array['baena','alex baena']),
  (7208, 'Marc Cucurella',      'Spain', array['cucurella','cucu']),
  (7209, 'Aymeric Laporte',     'Spain', array['laporte']),
  (7210, 'Pau Cubarsí',         'Spain', array['cubarsi','cubarsí','pau']),
  (7211, 'Unai Simón',          'Spain', array['simon','simón','unai']),
  -- Spain — substitutes used
  (7212, 'Pedri',               'Spain', array['pedri']),
  (7213, 'Ferran Torres',       'Spain', array['ferran','torres'])
on conflict (normative_id) do update
  set preferred_name = excluded.preferred_name,
      team = excluded.team,
      aliases = excluded.aliases;

insert into fixture_players (fixture_id, fixture_player_id, normative_id, participant, starter)
select ids.fid, roster.normative_id, roster.normative_id, roster.participant, roster.starter
from (
  select 9001 as fid
  union all
  select generate_series(9101, 9130)
) ids(fid)
cross join (values
  -- France (participant 1)
  (7001, 1, true),  (7003, 1, true),  (7004, 1, true),  (7006, 1, true),
  (7007, 1, true),  (7008, 1, true),  (7009, 1, true),  (7010, 1, true),
  (7011, 1, true),  (7012, 1, true),  (7013, 1, true),
  (7014, 1, false), (7015, 1, false), (7016, 1, false), (7017, 1, false),
  -- Spain (participant 2)
  (7201, 2, true),  (7202, 2, true),  (7203, 2, true),  (7204, 2, true),
  (7205, 2, true),  (7206, 2, true),  (7207, 2, true),  (7208, 2, true),
  (7209, 2, true),  (7210, 2, true),  (7211, 2, true),
  (7212, 2, false), (7213, 2, false)
) roster(normative_id, participant, starter)
on conflict (fixture_id, fixture_player_id) do nothing;
