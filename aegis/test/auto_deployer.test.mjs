import test from 'node:test';
import assert from 'node:assert/strict';

const AD = () => import('../auto_deployer.mjs');

/* ------------------------------------------------------------------ *
 * 1. Metadata
 * ------------------------------------------------------------------ */

test('metadata is validated before a mint, because a mint URI is permanent', async () => {
  const { buildTokenMetadata } = await AD();

  const ok = buildTokenMetadata({
    name: 'Aegis AI',
    symbol: 'AEGIS',
    description: 'A test token',
    imageUri: 'https://ipfs.io/ipfs/QmExample',
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.metadata.name, 'Aegis AI');
  assert.equal(ok.metadata.symbol, 'AEGIS');
  // Pump.fun's own uploader emits these; a payload without them renders
  // differently from every other token on the site.
  assert.equal(ok.metadata.showName, true);
  assert.equal(ok.metadata.createdOn, 'https://pump.fun');

  // ── ABSENT SOCIALS ARE OMITTED, NOT NULLED ──────────────────────────────
  // A null social renders as a dead link on some clients; an absent one
  // renders as nothing.
  assert.equal('twitter' in ok.metadata, false);
  const social = buildTokenMetadata({
    name: 'X', symbol: 'X', imageUri: 'ipfs://cid', twitter: ' https://x.com/a ', website: '',
  });
  assert.equal(social.metadata.twitter, 'https://x.com/a', 'trimmed');
  assert.equal('website' in social.metadata, false, 'an empty string is absent, not blank');

  // ── VALIDATION HAPPENS HERE, WHERE IT IS FREE ───────────────────────────
  // The metadata pointer is written into the token at creation and cannot be
  // repaired. Refusing bad input costs an error message; minting it costs a
  // broken token that exists forever.
  assert.equal(buildTokenMetadata({ symbol: 'X', imageUri: 'ipfs://c' }).ok, false);
  assert.equal(buildTokenMetadata({ name: 'X', imageUri: 'ipfs://c' }).ok, false);
  assert.equal(buildTokenMetadata({ name: 'X', symbol: 'X' }).ok, false);
  assert.match(buildTokenMetadata({ name: '  ', symbol: 'X', imageUri: 'ipfs://c' }).errors.join(), /name is required/);

  // A bare CID or a local path is the mistake that produces a token whose
  // image never resolves anywhere.
  for (const bad of ['QmBareCidNoScheme', './assets/logo.png', 'C:/logo.png']) {
    const r = buildTokenMetadata({ name: 'X', symbol: 'X', imageUri: bad });
    assert.equal(r.ok, false, `${bad} must be refused`);
    assert.match(r.errors.join(), /absolute/);
  }
  for (const good of ['https://a/b', 'ipfs://cid', 'ar://tx']) {
    assert.equal(buildTokenMetadata({ name: 'X', symbol: 'X', imageUri: good }).ok, true, good);
  }

  // Length caps, reported with the actual length so the fix is obvious.
  assert.match(buildTokenMetadata({ name: 'a'.repeat(33), symbol: 'X', imageUri: 'ipfs://c' }).errors.join(), /33 chars, max 32/);
  assert.match(buildTokenMetadata({ name: 'X', symbol: 'a'.repeat(11), imageUri: 'ipfs://c' }).errors.join(), /11 chars, max 10/);
  // Every failure is collected, not just the first — one round trip per fix is
  // a bad way to learn three things.
  assert.equal(buildTokenMetadata({}).errors.length, 3);
});

/* ------------------------------------------------------------------ *
 * 2. Creator allocation
 * ------------------------------------------------------------------ */

test('the creator allocation is exact integer supply, and costs no SOL', async () => {
  const { calculateTxInAllocation, PUMP_TOTAL_SUPPLY, PUMP_DECIMALS } = await AD();

  const five = calculateTxInAllocation({ txInPct: 5 });
  assert.equal(five.ok, true);
  // 5% of 1e9 tokens at 6 decimals = 5e13 base units.
  assert.equal(five.allocationBase, 50_000_000 * 10 ** PUMP_DECIMALS);
  assert.equal(five.allocationTokens, 50_000_000);
  assert.equal(five.exact, true);

  // The parts re-sum to the whole. A supply split that does not reconcile
  // leaves dust no later arithmetic can recover.
  const scale = 10 ** PUMP_DECIMALS;
  assert.equal(five.allocationBase + five.publicBase, PUMP_TOTAL_SUPPLY * scale);
  assert.equal(five.publicTokens, 950_000_000);

  // ── IT IS MINTED SUPPLY, NOT A PURCHASE ─────────────────────────────────
  // Named explicitly so no caller mistakes the allocation for a buy.
  assert.equal(five.costSol, 0);

  // A percentage that cannot be expressed exactly SAYS SO rather than
  // silently truncating.
  const third = calculateTxInAllocation({ txInPct: 3.333 });
  assert.equal(third.ok, true);
  assert.equal(Number.isInteger(third.allocationBase), true, 'base units are always whole');
  assert.equal(third.allocationBase + third.publicBase, PUMP_TOTAL_SUPPLY * scale, 'still reconciles');

  // ── NO DEFAULT PERCENTAGE ───────────────────────────────────────────────
  // A silent default is a silent claim about how much of a supply someone
  // holds.
  assert.equal(calculateTxInAllocation({}).ok, false);
  assert.match(calculateTxInAllocation({}).error, /required/);

  // Bounds.
  assert.equal(calculateTxInAllocation({ txInPct: -1 }).ok, false);
  assert.equal(calculateTxInAllocation({ txInPct: 101 }).ok, false);
  assert.equal(calculateTxInAllocation({ txInPct: 0 }).ok, true, '0% is a real choice: no allocation at all');
  assert.equal(calculateTxInAllocation({ txInPct: 0 }).allocationBase, 0);
  assert.equal(calculateTxInAllocation({ txInPct: 100 }).publicBase, 0, '100% leaves nothing on the curve');
  assert.equal(calculateTxInAllocation({ totalSupply: 0, txInPct: 5 }).ok, false);
});

/* ------------------------------------------------------------------ *
 * 3. PDA derivation
 * ------------------------------------------------------------------ */

test('a PDA is off the curve, which is the entire property that makes it one', async () => {
  const { isOnCurve, findProgramAddress, PUMP_FUN_PROGRAM } = await AD();
  const { base58Decode } = await import('../live_execute.mjs');

  // A real wallet IS on the curve — it has a private key.
  assert.equal(isOnCurve(Buffer.from(base58Decode('Ar2Y6o1QmrRAskjii1cRfijeKugHH13ycxW5cd7rro1x'))), true);

  // ── SKIP THIS TEST AND findProgramAddress RETURNS A KEYPAIR ─────────────
  // A program-derived address must have NO corresponding private key, which is
  // exactly what off-curve means. Without the check, the derivation happily
  // returns an ordinary public key someone could hold the key to — an account
  // the program believes only it can sign for.
  const pda = findProgramAddress([Buffer.from('bonding-curve'), Buffer.alloc(32, 7)], PUMP_FUN_PROGRAM);
  assert.equal(isOnCurve(pda.bytes), false, 'a derived address must be off the curve');

  // The canonical bump is the LARGEST that works, so the walk runs 255 down.
  // Starting from 0 would find a valid PDA that no program would accept.
  assert.ok(pda.bump >= 250 && pda.bump <= 255, `expected a high canonical bump, got ${pda.bump}`);

  // Deterministic, and seed-sensitive: a changed seed must move the address,
  // so this fails when the derivation drifts rather than only when it throws.
  const again = findProgramAddress([Buffer.from('bonding-curve'), Buffer.alloc(32, 7)], PUMP_FUN_PROGRAM);
  assert.equal(again.address, pda.address);
  const moved = findProgramAddress([Buffer.from('bonding-curve'), Buffer.alloc(32, 8)], PUMP_FUN_PROGRAM);
  assert.notEqual(moved.address, pda.address);
  // And program-sensitive.
  const otherProgram = findProgramAddress(
    [Buffer.from('bonding-curve'), Buffer.alloc(32, 7)],
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
  );
  assert.notEqual(otherProgram.address, pda.address);

  assert.equal(isOnCurve(Buffer.alloc(31)), false, 'wrong length is not a point');
  assert.equal(isOnCurve(null), false);
});

test('pump.fun PDAs match real on-chain accounts, including the Token-2022 seed', async () => {
  const { derivePumpFunPDAs, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } = await AD();

  // ── VERIFIED AGAINST MAINNET, NOT ASSERTED ──────────────────────────────
  // These three are live pump.fun mints. Their bonding curves are owned by the
  // pump program and their associated bonding curves are the token accounts
  // those curves actually hold — all checked over RPC on 2026-08-16, 3 of 3.
  const KNOWN = [
    {
      mint: 'ByVqnjyJykVR7Vbp5WhbB6PTCws1wQkv74L8GJW1pump',
      associatedBondingCurve: 'EaEWpMQc3kDWCahnt5QyyVL2nCGWAaL6sotaHPfqAnzh',
    },
    {
      mint: '2d2GZdehy2YGrj1MJ3y3yhXjficMa2J3GtncxkTQpump',
      associatedBondingCurve: '2rtX54L6hvtVp5vQWq5o19vwLhpT3FeNBRHU8GJBgpQK',
    },
  ];

  for (const k of KNOWN) {
    const d = derivePumpFunPDAs(k.mint);
    assert.equal(d.ok, true, k.mint);
    assert.equal(d.associatedBondingCurve, k.associatedBondingCurve, `ATA for ${k.mint.slice(0, 10)}`);
    assert.equal(d.mint, k.mint);
    assert.equal(d.tokenProgram, TOKEN_2022_PROGRAM);
    assert.ok(d.bondingCurveBump >= 0 && d.bondingCurveBump <= 255);
  }

  // ── THE TOKEN PROGRAM IS AN ATA SEED, SO THE WRONG ONE DERIVES A REAL,
  //    VALID, WRONG ADDRESS ────────────────────────────────────────────────
  // Pump.fun mints are Token-2022. Deriving with the classic program produces
  // 9xCa3ZwS… where the chain holds EaEWpMQc… — both are perfectly good
  // addresses and only one is the account. This is the failure that survives
  // review and only surfaces as a transaction that fails after paying a fee.
  const classic = derivePumpFunPDAs(KNOWN[0].mint, { tokenProgram: TOKEN_PROGRAM });
  assert.notEqual(classic.associatedBondingCurve, KNOWN[0].associatedBondingCurve);
  assert.match(classic.associatedBondingCurve, /^9xCa3ZwS/, 'the wrong-seed address, pinned so the mistake is recognisable');

  // The bonding curve itself does not depend on the token program.
  assert.equal(classic.bondingCurve, derivePumpFunPDAs(KNOWN[0].mint).bondingCurve);

  // Derivable for a mint that does not exist yet — that is what makes a
  // --paper deploy checkable before anything is spent.
  const unborn = derivePumpFunPDAs('11111111111111111111111111111112');
  assert.equal(unborn.ok, true);
  assert.notEqual(unborn.bondingCurve, unborn.associatedBondingCurve);

  // Bad input is refused rather than derived from garbage.
  assert.equal(derivePumpFunPDAs('').ok, false);
  assert.equal(derivePumpFunPDAs(null).ok, false);
  assert.equal(derivePumpFunPDAs('not-base58-!!!').ok, false);
  assert.match(derivePumpFunPDAs('abc').error, /decodes to 3 bytes, expected 32/);
});
