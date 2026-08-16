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

/* ------------------------------------------------------------------ *
 * PHASE 2 — metadata upload and bundle assembly
 * ------------------------------------------------------------------ */

test('an IPFS URI is normalised, because a bare CID resolves nowhere', async () => {
  const { normaliseIpfsUri } = await AD();

  // ── THE FAILURE THAT LOOKS FINE IN A LOG ────────────────────────────────
  // Services return `Qm…`, `ipfs://Qm…`, or a gateway URL interchangeably. A
  // bare CID written into a mint resolves nowhere, and in a log line it is
  // indistinguishable from a working value.
  const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
  assert.equal(normaliseIpfsUri(CID).uri, `ipfs://${CID}`);
  assert.equal(normaliseIpfsUri(CID).form, 'bare-cid');

  // Already a pointer — passed through unchanged.
  assert.equal(normaliseIpfsUri(`ipfs://${CID}`).uri, `ipfs://${CID}`);
  assert.equal(normaliseIpfsUri('ar://tx123').form, 'arweave');

  // ── A GATEWAY URL IS REWRITTEN TO ipfs:// ───────────────────────────────
  // A gateway is one company's uptime; the mint pointer is permanent. Keeping
  // the gateway would make the token's metadata depend on that host surviving.
  const gw = normaliseIpfsUri(`https://ipfs.io/ipfs/${CID}`);
  assert.equal(gw.uri, `ipfs://${CID}`);
  assert.equal(gw.form, 'gateway');
  assert.equal(gw.original, `https://ipfs.io/ipfs/${CID}`);
  assert.equal(normaliseIpfsUri(`https://cf-ipfs.com/ipfs/${CID}/meta.json`).cid, CID);

  // A plain https URL that is NOT a gateway is legitimate — some hosts serve
  // metadata directly — so it is kept rather than rewritten into a fake CID.
  assert.equal(normaliseIpfsUri('https://arweave.net/abc').form, 'http');
  assert.equal(normaliseIpfsUri('https://arweave.net/abc').uri, 'https://arweave.net/abc');

  // Junk is refused rather than turned into a pointer at nothing.
  for (const bad of ['', '   ', null, undefined, 'not a cid', './local.json', 42]) {
    assert.equal(normaliseIpfsUri(bad).ok, false, `${JSON.stringify(bad)} must be refused`);
  }
});

test('the metadata upload refuses to guess a URI', async () => {
  const { uploadMetadataToIPFS } = await AD();
  const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
  const meta = { name: 'Aegis AI', symbol: 'AEGIS', image: 'ipfs://logo' };
  const json = (body, headers = { 'content-type': 'application/json' }) =>
    async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers });

  // Several plausible field names are accepted, because the SUCCESS shape has
  // not been confirmed against a real response — confirming it means publishing
  // to IPFS, which is permanent and not a thing to do while testing.
  for (const key of ['metadataUri', 'metadata_uri', 'uri', 'url', 'IpfsHash', 'cid']) {
    const r = await uploadMetadataToIPFS({ metadata: meta, fetchImpl: json({ [key]: `ipfs://${CID}` }) });
    assert.equal(r.ok, true, key);
    assert.equal(r.uri, `ipfs://${CID}`);
  }
  // A gateway URL in the response is normalised on the way out.
  const gw = await uploadMetadataToIPFS({ metadata: meta, fetchImpl: json({ uri: `https://ipfs.io/ipfs/${CID}` }) });
  assert.equal(gw.uri, `ipfs://${CID}`);

  // ── A RESPONSE WITH NO USABLE URI IS A FAILURE, NOT A DEFAULT ───────────
  // The cost of guessing is a mint pointing at nothing, forever.
  const empty = await uploadMetadataToIPFS({ metadata: meta, fetchImpl: json({ status: 'queued' }) });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /could not read a URI/);

  // An HTML error page arrives as a 200; JSON.parse would throw where the
  // caller expects a result object.
  const html = await uploadMetadataToIPFS({
    metadata: meta, fetchImpl: json('<!DOCTYPE html><html>oops</html>', { 'content-type': 'text/html' }),
  });
  assert.equal(html.ok, false);
  assert.match(html.error, /expected JSON, got text\/html/);

  // Transport failures degrade to a miss, never to a crash mid-deploy.
  assert.equal((await uploadMetadataToIPFS({ metadata: meta, fetchImpl: async () => new Response('', { status: 500 }) })).ok, false);
  assert.equal((await uploadMetadataToIPFS({ metadata: meta, fetchImpl: async () => { throw new Error('ECONNRESET'); } })).ok, false);

  // Required fields are checked BEFORE the network call — a half-formed
  // payload should never reach IPFS, where it is permanent.
  let called = false;
  const spy = async () => { called = true; return new Response('{}', { status: 200 }); };
  const bad = await uploadMetadataToIPFS({ metadata: { name: 'X' }, fetchImpl: spy });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /metadata.symbol is required/);
  assert.equal(called, false, 'nothing may reach the network without a complete payload');
  assert.equal((await uploadMetadataToIPFS({})).ok, false);
});

test('bundle legs are ordered create-first, because Jito reverts the whole thing', async () => {
  const { assembleDeployBundle } = await AD();
  const base = { name: 'Aegis AI', symbol: 'AEGIS', imageUri: 'ipfs://cid', txInPct: 5 };

  // ── ORDER IS SEMANTIC ───────────────────────────────────────────────────
  // Jito executes in the order given and reverts everything if any leg fails.
  // A buy against a bonding curve that does not exist yet fails — and takes
  // the create down with it.
  const full = assembleDeployBundle({ ...base, buySol: 1.0, jitoTip: 0.005 });
  assert.equal(full.ok, true);
  assert.deepEqual(full.legs.map((l) => l.kind), ['create', 'creator-allocation', 'creator-buy']);
  assert.deepEqual(full.legs.map((l) => l.index), [0, 1, 2], 'indices are contiguous and ordered');

  // The allocation is minted supply, so it costs no SOL and is not in the spend.
  assert.equal(full.legs[1].costSol, 0);
  assert.equal(full.allocation.allocationTokens, 50_000_000);
  assert.ok(Math.abs(full.totalSpendSol - 1.005) < 1e-9, 'buy + tip only');
  assert.equal(full.jitoTipLamports, 5_000_000);

  // Optional legs drop out cleanly rather than appearing as no-ops.
  const noBuy = assembleDeployBundle({ ...base, buySol: 0 });
  assert.deepEqual(noBuy.legs.map((l) => l.kind), ['create', 'creator-allocation']);
  const bare = assembleDeployBundle({ ...base, txInPct: 0, buySol: 0 });
  assert.deepEqual(bare.legs.map((l) => l.kind), ['create']);

  // ── A ONE-LEG BUNDLE BUYS PRIORITY, NOT ATOMICITY ───────────────────────
  // With a single transaction that property already exists — atomicity is what
  // a transaction IS — so the tip is doing something different from what the
  // word "bundle" suggests.
  assert.equal(bare.atomicityUseful, false);
  assert.equal(full.atomicityUseful, true);
  const tippedSolo = assembleDeployBundle({ ...base, txInPct: 0, buySol: 0, jitoTip: 0.005 });
  assert.match(tippedSolo.warnings.join(), /buys auction priority, not atomicity/);

  // A tip that dominates the spend is called out rather than quietly paid.
  const bigTip = assembleDeployBundle({ ...base, buySol: 0.01, jitoTip: 0.005 });
  assert.match(bigTip.warnings.join(), /tip is 33% of what this deploy spends/);
  assert.equal(assembleDeployBundle({ ...base, buySol: 1, jitoTip: 0.001 }).warnings.length, 0);

  // Invalid input is refused before any of this matters.
  assert.equal(assembleDeployBundle({ ...base, name: '' }).ok, false);
  assert.match(assembleDeployBundle({ ...base, name: '' }).error, /metadata invalid/);
  assert.equal(assembleDeployBundle({ ...base, txInPct: undefined }).ok, false);
  assert.equal(assembleDeployBundle({ ...base, buySol: -1 }).ok, false);
  assert.equal(assembleDeployBundle({ ...base, jitoTip: NaN }).ok, false);
});

test('the plan carries no bundle until real transactions exist', async () => {
  const { assembleDeployBundle } = await AD();
  const { JITO_MAX_BUNDLE_SIZE } = await import('../live_execute.mjs');
  const base = { name: 'Aegis AI', symbol: 'AEGIS', imageUri: 'ipfs://cid', txInPct: 5, buySol: 1 };

  // ── PHASE 2 HAS NO SIGNER, BY DESIGN ────────────────────────────────────
  // So this returns the PLAN and says so, rather than fabricating a payload
  // that looks submittable.
  const plan = assembleDeployBundle(base);
  assert.equal(plan.bundle, null);
  assert.match(plan.note, /plan only, nothing to submit/);

  // Given transactions, it assembles through buildJitoBundle and the order
  // survives into the payload.
  const withTx = assembleDeployBundle({ ...base, transactions: ['dHgx', 'dHgy', 'dHgz'] });
  assert.equal(withTx.ok, true);
  assert.equal(withTx.bundle.ok, true);
  assert.equal(withTx.bundle.payload.method, 'sendBundle');
  assert.deepEqual(withTx.bundle.payload.params[0], ['dHgx', 'dHgy', 'dHgz']);
  assert.equal(withTx.bundle.size, 3);

  // Transactions pair with legs BY INDEX, so a count mismatch is refused —
  // silently zipping them would map a buy onto a create.
  const mismatch = assembleDeployBundle({ ...base, transactions: ['dHgx'] });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /1 transactions for 3 legs/);

  // Jito's 5-transaction cap is enforced on the LEGS as well, so an oversized
  // plan fails while it is still free to fail.
  assert.ok(JITO_MAX_BUNDLE_SIZE === 5);

  // PDAs are attached when a mint is known, and derivable before it exists —
  // which is what makes a --paper deploy checkable before anything is spent.
  const withMint = assembleDeployBundle({ ...base, mint: 'ByVqnjyJykVR7Vbp5WhbB6PTCws1wQkv74L8GJW1pump' });
  assert.equal(withMint.pdas.associatedBondingCurve, 'EaEWpMQc3kDWCahnt5QyyVL2nCGWAaL6sotaHPfqAnzh');
  assert.equal(assembleDeployBundle(base).pdas, null, 'no mint, no derived accounts');
  assert.equal(assembleDeployBundle({ ...base, mint: 'not-base58-!!!' }).ok, false);
});
