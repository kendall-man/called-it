import {
  requireGroupPointsDbClient,
  type GroupPointsDb,
} from './group-points-contract.js';
import { groupPointsQueryMethods } from './group-points-queries.js';
import { groupPointsRpcMethods } from './group-points-rpc.js';

export type {
  GroupPointsDb,
  GroupPointsDbClient,
  GroupPointsFilterBuilder,
  GroupPointsTableBuilder,
} from './group-points-contract.js';

export function groupPointsDbFromClient(candidate: unknown): GroupPointsDb {
  const client = requireGroupPointsDbClient(candidate);
  return {
    ...groupPointsRpcMethods(client),
    ...groupPointsQueryMethods(client),
  } satisfies GroupPointsDb;
}
