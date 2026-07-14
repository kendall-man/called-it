export const ESCROW_PROGRAM_ID = 'HrKUo8Bue31kU9sobzQGK5qDxVxBu5nBLXP3aGeKCDFL';

export const ESCROW_INSTRUCTION_DISCRIMINATORS = {
  initialize_config: [208, 127, 21, 1, 194, 190, 196, 70],
  rotate_config: [14, 194, 225, 236, 162, 78, 30, 83],
  rotate_oracle_set: [16, 16, 37, 165, 158, 79, 145, 13],
  set_pause: [63, 32, 154, 2, 56, 103, 79, 45],
  initialize_market: [35, 35, 189, 193, 155, 48, 170, 203],
  freeze_market: [184, 154, 237, 98, 127, 82, 217, 180],
  unfreeze_market: [27, 123, 237, 162, 61, 82, 42, 234],
  place_position: [218, 31, 90, 75, 101, 209, 5, 253],
  activate_position_lot: [103, 117, 132, 237, 19, 177, 249, 210],
  invalidate_position_lot: [218, 95, 132, 244, 150, 115, 16, 73],
  settle_market: [193, 153, 95, 216, 166, 6, 144, 217],
  calculate_position_entitlement: [68, 120, 118, 224, 91, 52, 41, 225],
  void_market: [243, 175, 46, 124, 95, 101, 39, 69],
  timeout_void: [12, 211, 235, 186, 179, 108, 98, 208],
  claim_position: [168, 90, 89, 44, 203, 246, 210, 46],
  claim_position_for: [78, 128, 143, 121, 217, 191, 221, 71],
  close_position_lots: [148, 137, 14, 114, 167, 75, 97, 152],
  close_position: [123, 134, 81, 0, 49, 68, 98, 98],
  close_market: [88, 154, 248, 186, 48, 14, 123, 244],
} as const;

export type EscrowInstructionKind = keyof typeof ESCROW_INSTRUCTION_DISCRIMINATORS;

export interface EscrowAccountMetaSchema {
  readonly name: string;
  readonly signer: boolean;
  readonly writable: boolean;
  readonly remaining?: boolean;
}

const account = (name: string, signer = false, writable = false): EscrowAccountMetaSchema => ({
  name,
  signer,
  writable,
});

export const ESCROW_INSTRUCTION_ACCOUNTS: Readonly<Record<EscrowInstructionKind, readonly EscrowAccountMetaSchema[]>> = {
  initialize_config: [account('initializer', true, true), account('config', false, true), account('escrowProgram'), account('programData'), account('systemProgram')],
  rotate_config: [account('config', false, true), account('configAuthority', true)],
  rotate_oracle_set: [account('config', false, true), account('configAuthority', true), account('currentOracleSet'), account('newOracleSet', false, true), account('payer', true, true), account('systemProgram')],
  set_pause: [account('config', false, true), account('authority', true)],
  initialize_market: [account('config'), account('oracleSet'), account('marketCreationAuthority', true), account('payer', true, true), account('market', false, true), account('vault', false, true), account('tokenMint'), account('tokenProgram'), account('associatedTokenProgram'), account('systemProgram')],
  freeze_market: [account('config'), account('feedOperatorAuthority', true), account('market', false, true)],
  unfreeze_market: [account('config'), account('oracleSet'), account('market', false, true), account('instructionsSysvar')],
  place_position: [account('config'), account('market', false, true), account('payer', true, true), account('owner', true, true), account('position', false, true), account('lot', false, true), account('vault', false, true), account('assetSource', false, true), account('tokenMint'), account('tokenProgram'), account('systemProgram')],
  activate_position_lot: [account('market', false, true), account('position', false, true), account('lot', false, true)],
  invalidate_position_lot: [account('config'), account('oracleSet'), account('market', false, true), account('position', false, true), account('lot', false, true), account('instructionsSysvar')],
  settle_market: [account('config'), account('oracleSet'), account('market', false, true), account('instructionsSysvar')],
  calculate_position_entitlement: [account('market', false, true), account('position', false, true)],
  void_market: [account('config'), account('oracleSet'), account('market', false, true), account('instructionsSysvar')],
  timeout_void: [account('market', false, true)],
  claim_position: [account('market', false, true), account('position', false, true), account('owner', true, true), account('vault', false, true), account('tokenMint'), account('ownerTokenAccount', false, true), account('tokenProgram'), account('associatedTokenProgram'), account('systemProgram')],
  claim_position_for: [account('payer', true, true), account('market', false, true), account('position', false, true), account('owner', false, true), account('vault', false, true), account('tokenMint'), account('ownerTokenAccount', false, true), account('tokenProgram'), account('associatedTokenProgram'), account('systemProgram')],
  close_position_lots: [account('config'), account('market'), account('position', false, true), account('rentRecipient', false, true), account('systemProgram'), { ...account('lots', false, true), remaining: true }],
  close_position: [account('config'), account('market', false, true), account('position', false, true), account('rentRecipient', false, true)],
  close_market: [account('market', false, true), account('vault', false, true), account('residualRecipient', false, true), account('tokenMint'), account('residualTokenAccount', false, true), account('tokenProgram'), account('systemProgram')],
};

export const ESCROW_ACCOUNT_DISCRIMINATORS = {
  ProtocolConfig: [207, 91, 250, 28, 152, 179, 215, 209],
  OracleSet: [128, 26, 73, 134, 218, 90, 126, 42],
  Market: [219, 190, 213, 55, 0, 227, 198, 154],
  UserPosition: [251, 248, 209, 245, 83, 234, 17, 27],
  PositionLot: [111, 185, 82, 98, 173, 94, 132, 16],
} as const;

export const ESCROW_EVENT_DISCRIMINATORS = {
  ProtocolConfigInitialized: [243, 69, 27, 238, 111, 169, 87, 231],
  ProtocolConfigRotated: [109, 27, 20, 186, 107, 198, 14, 44],
  OracleSetRotated: [126, 245, 16, 82, 133, 143, 187, 15],
  ProtocolPauseChanged: [67, 33, 235, 73, 71, 124, 172, 110],
  MarketInitialized: [134, 160, 122, 87, 50, 3, 255, 81],
  MarketFrozen: [162, 36, 213, 206, 25, 118, 210, 158],
  MarketUnfrozen: [158, 104, 197, 243, 10, 245, 181, 51],
  PositionPlaced: [98, 254, 173, 163, 231, 220, 66, 210],
  PositionActivated: [107, 62, 74, 102, 27, 211, 70, 149],
  PositionInvalidated: [214, 165, 186, 120, 136, 141, 216, 202],
  MarketSettlementStarted: [57, 114, 235, 229, 240, 159, 32, 143],
  PositionEntitlementCalculated: [237, 117, 56, 238, 241, 136, 79, 53],
  MarketSettled: [237, 212, 22, 175, 201, 117, 215, 99],
  MarketVoided: [217, 12, 138, 39, 108, 75, 89, 26],
  PositionClaimed: [149, 250, 141, 45, 210, 198, 94, 148],
  PositionLotsClosed: [253, 103, 46, 41, 67, 37, 226, 166],
  PositionClosed: [157, 163, 227, 228, 13, 97, 138, 121],
  MarketClosed: [86, 91, 119, 43, 94, 0, 217, 113],
} as const;
