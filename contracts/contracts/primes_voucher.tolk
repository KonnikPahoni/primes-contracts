tolk 1.4

// ============================================================================
// TON PRIMES — Voucher claim. EARN_PLAN.md §3 (E2).
// Spec: CONCEPT.md §9.5 (signed vouchers), §9.4 (quests / verified virality),
// §3.3 (PRIMES emission), §3.4 (three pools, three owners), §8 (anti-abuse).
// Wire: /shared/schemas/voucher.tlb, /shared/opcodes.ts VOUCHER.
// Params: /shared/params.json genesis.era_bounty_schedule.remaining_vault_split
//         .tracks.quests.primes — the program's whole budget, enforced by the
//         VAULT's allow-list entry and not by this contract. What THIS contract
//         bounds is one wallet: `VoucherInit.maxPerWallet` (audit 2026-11-19 R2-M2),
//         shared/voucher.ts `VOUCHER_MAX_PER_WALLET`, refused 716 above it.
//
// ---- What this contract is for ----
//
// Some things a player does are not facts a contract can check. Connecting the
// bot, a Telegram story that produced counted starts, a game score — §9.4 calls
// these the off-chain-scored tracks, and §9.5 is the mechanism that pays them
// without putting an operator in the payment path: the backend SIGNS a claim,
// and the player REDEEMS it themselves.
//
// On-chain-checkable rewards do NOT come through here. Recruit quests and prime
// quests are contract facts, and §9.4's whole
// point is that they must be verified in the claim transaction rather than
// attested by a server. Routing one of those through a voucher would be a
// downgrade from proof to assertion, and EARN_PLAN §3 says so explicitly.
//
// ---- The three properties that make this safe to hand a signing key ----
//
// 1. CUMULATIVE, NOT INCREMENTAL. A voucher says "this wallet has earned T in
//    total", never "pay this wallet x". The claimant's RECEIPT (a child at an
//    address derived from this contract and the wallet — D-191 point 2,
//    primes_claim_receipt.tolk) pays `T - alreadyPaid` and stores T. So replaying a voucher pays ZERO (not "is rejected" — zero, by
//    arithmetic, which is a stronger statement than a replay-protection flag
//    because there is no nonce to get wrong). Two vouchers arriving out of order
//    settle to the higher one and the lower one becomes a no-op. The backend
//    never has to know which of its vouchers were redeemed.
//
// 2. PRIMES ONLY, FROM THE VAULT, WITHIN A GENESIS-FIXED BUDGET. This contract
//    holds no PRIMES and cannot mint any. It asks the bounty vault to pay, and
//    the vault will only do that if this contract's address is in the allow-list
//    baked into the vault's deploy data, and only up to that entry's `remaining`
//    (primes_bounty_vault.tolk `PayProgramBounty`). The whole vault is already
//    pre-counted into `S` at genesis (§3.3/§5), so every payout this contract
//    ever causes moves tokens that the floor price has already accounted for:
//    `p_f` cannot move. There is no route by which this contract pays GRAM.
//
// 3. THE CLAIMANT PAYS. `claim_voucher` must come from the wallet being paid —
//    the signature covers the SENDER's address, not an address in the body — so
//    a voucher is not bearer paper, cannot be redirected, and the operator never
//    pays gas for a player's claim. This also means a leaked voucher is useless
//    to anyone but its subject.
//
// ---- ADMIN SURFACE: the burn, and why it is not one ----
//
// §8 forbids an admin withdraw path on any GRAM balance and this contract has
// none: no message here moves GRAM anywhere except as gas, and no message names a
// destination for PRIMES other than the sender.
//
// `burn_signer` ends the program. It is NOT authenticated by an owner address —
// there is no owner field — but by a SIGNATURE FROM THE SIGNING KEY ITSELF over
// (BURN_TAG, programTag, the network's global id, this contract's address,
// claimDeadline). Whoever holds the key can retire it; nobody else
// can, and holding the key is already strictly more power than retiring it. So
// the burn adds no authority that did not already exist.
//
// The burn cannot be used to strand an earned balance, and that is enforced
// arithmetically rather than promised: `claimDeadline >= now + BURN_MIN_GRACE`
// (90 days) is asserted at the contract. A burn therefore always leaves every
// holder of a signed voucher a full quarter to redeem it. After the deadline
// claims stop; the unspent remainder of the budget stays in the vault, where
// there is no withdraw path either, and — because §3.3 pre-counted it into `S` —
// an unspent bounty bucket is a floor-price gift to holders rather than money
// anyone lost.
//
// A burn is one-shot and irreversible: `burnedAt != 0` refuses a second one, so
// the deadline cannot be walked forward repeatedly to fake a live program.
//
// ---- Why signatures stay VALID after the burn ----
//
// The key is destroyed off-chain, so no new voucher can appear; the contract
// keeps checking signatures against the same stored public key because refusing
// them is exactly the stranding that EARN_PLAN §3 says not to do. The end of the
// program is the DEADLINE, not the flag.
// ============================================================================

// EARN_PLAN §3 / §9.5. 90 days, in seconds. This is not an economic parameter —
// it buys nothing and prices nothing — it is the minimum notice a program
// shutdown must give, so it is fixed here rather than in params.json. It is also
// a FLOOR on the deadline, never the deadline itself: the burner may give more
// notice and cannot give less.
const BURN_MIN_GRACE: int = 7776000;

// Domain separator, so a burn authorisation can never be replayed as a payout
// authorisation or vice versa. The two signed messages have different shapes
// AND different first fields; either alone would do, and both is cheap.
const BURN_TAG: int = 0x4255524e;   // "BURN"
const CLAIM_TAG: int = 0x434c414d;  // "CLAM"

// §9.5 "the claimant pays their own gas", enforced: the least a paying claim may
// attach. It is CARRIED through the receipt (whose first deploy keeps a 0.01
// storage reserve) and on to the vault (mode 64), so it covers the vault's own
// TRANSFER_GAS jetton hop (0.1, which may deploy the claimant's PRIMES wallet)
// as well as the inbox hop — the same 0.15 the vault's `ClaimDiscovery` charges.
// Before this the voucher paid a flat 0.03 out of its own balance per claim.
const CLAIM_MIN_VALUE: coins = 150000000; // 0.15 GRAM

struct Storage {
    // §9.5's signing key. Set at deploy and NEVER written by any message: a
    // rotate path would be a standing credential to re-open a burned program,
    // which is the one thing the burn is supposed to make impossible. Rotating
    // the key means a fresh deploy and a fresh allow-list entry at genesis.
    signerPubkey: uint256
    // 0 while the program is live; else the second the burn landed. Doubles as
    // the one-shot flag, so no separate boolean can disagree with it.
    burnedAt: uint32
    // Absolute deadline for claims, set by the burn. 0 = no deadline = live.
    claimDeadline: uint32
    // BOUND: this contract holds NO per-claimant map (D-191 point 2, V26.3). The
    // high-water mark that is the whole of the replay protection lives on
    // `primes_claim_receipt.tolk`, one child per claimant, whose code is here so
    // this contract can derive (and trust) its address. Storage is fixed-size.
    receiptCode: cell
    // §9.1: the program's own two-number report, so `/earn`'s claims panel reads
    // what this contract actually did rather than summing the backend's beliefs.
    paidTotal: coins
    claimCount: uint32
    // D22 (continuing the D7/D11/D12/D21 family). The vault's allow-list is part
    // of the VAULT's address-determining data and no message can ever write to
    // it, so the vault's address depends on this contract's address — while this
    // contract needs the vault's address to send to. A genuine circular
    // dependency with no fixed point, resolved the same way every other one in
    // this repo is: deploy with `vaultAddr` unset, and let the genesis script
    // lock it in once with a one-shot `SetVault`. After `vaultSet = 1` no message
    // can change it again, so this is a used-up bootstrap credential and not a
    // standing admin key — the same shape as the vault's own `SetWallet`.
    vaultAddr: address
    vaultSet: uint8
    // Write-once init data, in a ref because the root cell is at the 1023-bit limit.
    init: Cell<VoucherInit>
}

struct VoucherInit {
    // The vault track this instance draws on, named in every `PayProgramBounty`
    // and asserted by the vault against its allow-list entry
    // (`vault_not_allowlisted`). Never written: "QSTS" for §9.4's quests, "PQST"
    // for its contract-fact quests (D-171), "SECU" for D-170's security prize —
    // three instances of this one code, three keys, three entries. The TRACK amount
    // is never here; it is the entry's `remaining`, from params.json.
    programTag: uint32
    genesisScriptAddr: address
    // Audit 2026-11-19 R2-M2: the most this instance may EVER pay one wallet, in
    // nano-PRIMES. Deploy data, never written. The receipt pays `total - paid` and
    // stores the total, so bounding the SIGNED total bounds a wallet's lifetime
    // payout: a stolen signing key can then drain a track only one capped wallet at
    // a time, each paying its own >= 0.15 GRAM claim. From params.json at genesis
    // (contracts/scripts/genesisPipeline.ts): QSTS one board, PQST one board, SECU
    // the whole one-prize track (D-170).
    maxPerWallet: coins
}

fun Storage.load() {
    return Storage.fromCell(contract.getData())
}

fun Storage.save(self) {
    contract.setData(self.toCell())
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

// Permissionless in the only sense that matters: anyone may send it, but the
// signature covers the SENDER, so it can only ever pay whoever sent it.
struct (0x9a000001) ClaimVoucher {
    queryId: uint64
    cumulativeTotal: coins  // total PRIMES earned to date, per the backend
    validUntil: uint32      // unix seconds; the backend's own expiry on this voucher
    signature: bits512      // Ed25519 over hashSignedClaim(...) below
}

// Permissionless to send; authenticated by the signing key's own signature.
struct (0x9a000002) BurnSigner {
    queryId: uint64
    claimDeadline: uint32   // must be >= now + BURN_MIN_GRACE
    signature: bits512      // Ed25519 over hashSignedBurn(...)
}

// D22: genesis-only one-shot. Points this program at the vault whose allow-list
// names it.
struct (0x9a000003) SetVault {
    queryId: uint64
    vaultAddr: address
}

// D-191 point 2: the per-claimant high-water mark's child. `ReceiptInit` mirrors
// primes_claim_receipt.tolk's `Storage` in its empty state, byte for byte; the
// spec asserts `getReceiptAddress(wallet)` equals the wrapper's derivation.
struct ReceiptInit {
    voucherAddr: address
    claimant: address
    paid: coins
}

fun receiptStateInit(receiptCode: cell, claimant: address): AutoDeployAddress {
    return AutoDeployAddress {
        workchain: 0,
        stateInit: ContractState {
            code: receiptCode,
            data: (ReceiptInit { voucherAddr: contract.getAddress(), claimant: claimant, paid: 0 }).toCell(),
        },
    };
}

fun receiptAddress(receiptCode: cell, claimant: address): address {
    return receiptStateInit(receiptCode, claimant).calculateAddress();
}

// voucher -> receipt(claimant): the claimant's signed total. Deploys it if absent.
struct (0x9a000004) ReceiptAdvance {
    queryId: uint64
    cumulativeTotal: coins
}

// receipt -> voucher: the mark moved; pay `delta` to `claimant`.
struct (0x9a000005) ReceiptDelta {
    queryId: uint64
    claimant: address
    delta: coins
}

// voucher -> receipt: the vault refused `amount`; take it back off the mark.
struct (0x9a000006) ReceiptRestore {
    queryId: uint64
    amount: coins
}

// Outbound to the bounty vault. Mirrors primes_bounty_vault.tolk's own struct;
// same opcode, and the shapes must stay identical (CLAUDE.md wire-format rule).
struct (0x90000002) PayProgramBounty {
    queryId: uint64
    programTag: uint32
    beneficiary: address
    amount: coins
}

type AllowedMessage = ClaimVoucher | BurnSigner | SetVault | ReceiptDelta;

// The network's global id: config param 19, `_ global_id:int32`, the value TVM's
// GLOBALID returns. Read through the stdlib rather than an `asm` wrapper, because
// NoAdminWithdraw.spec.ts bans `asm` in every contract (it could hide a SETCODE).
fun networkGlobalId(): int {
    return blockchain.configParam(19)!.beginParse().preloadInt(32);
}

// The signed payload for a claim. Built as a cell and hashed, so the backend can
// reproduce it with @ton/core's beginCell() and nothing has to agree about byte
// packing informally.
//
// The WALLET is in the hash and not in the body: that is what makes a voucher
// non-transferable. `validUntil` is in the hash so the backend can put a short
// life on a voucher without this contract needing a revocation list.
// G78 / D-171: the instance's `programTag` is in the hash, so two instances can never
// redeem each other's vouchers even on one key (their own keys since R2-M2).
// Audit 2026-11-19 M2: so is THIS CONTRACT'S ADDRESS. The tag alone left one key's
// vouchers valid on every deployment of the same instance (testnet then mainnet, or a
// redeploy), where the claim receipts start at zero. The address alone does not tell
// testnet from mainnet: the init holds only the key, tag, genesis wallet and receipt
// code, and a v4r2 genesis wallet has the same address on both, so a mainnet genesis
// run from the testnet .env lands every instance at its testnet address. The NETWORK's
// global id (config param 19: -239 mainnet, -3 testnet) is therefore in the hash too.
fun hashSignedClaim(programTag: int, wallet: address, cumulativeTotal: coins, validUntil: int): int {
    return beginCell()
        .storeUint(CLAIM_TAG, 32)
        .storeUint(programTag, 32)
        .storeInt(networkGlobalId(), 32)
        .storeAddress(contract.getAddress())
        .storeAddress(wallet)
        .storeCoins(cumulativeTotal)
        .storeUint(validUntil, 32)
        .endCell()
        .hash();
}

// The tag binds a burn to one instance too: retiring the quests program must not
// retire the prime-quests program, even on one key. The network id and address (M2)
// bind it to one DEPLOYMENT, so an old burn cannot end a later deployment's program early.
fun hashSignedBurn(programTag: int, claimDeadline: int): int {
    return beginCell()
        .storeUint(BURN_TAG, 32)
        .storeUint(programTag, 32)
        .storeInt(networkGlobalId(), 32)
        .storeAddress(contract.getAddress())
        .storeUint(claimDeadline, 32)
        .endCell()
        .hash();
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);
    var storage = lazy Storage.load();

    match (msg) {
        SetVault => {
            assert (in.senderAddress == storage.init.load().genesisScriptAddr) throw 100; // wrong_sender
            assert (storage.vaultSet == 0) throw 104; // already_processed
            storage.vaultAddr = msg.vaultAddr;
            storage.vaultSet = 1;
            storage.save();
        }

        ClaimVoucher => {
            // Until the vault is wired, this program cannot pay anybody — and
            // must not consume anyone's high-water mark pretending otherwise.
            assert (storage.vaultSet == 1) throw 715; // voucher_vault_unset
            // The program's own expiry, if it has been ended. Checked BEFORE the
            // voucher's own, because after the deadline nothing is claimable no
            // matter how fresh the signature is.
            if (storage.claimDeadline != 0) {
                assert (blockchain.now() <= storage.claimDeadline) throw 710; // voucher_program_closed
            }
            assert (blockchain.now() <= msg.validUntil) throw 711; // voucher_expired

            val init = storage.init.load();
            val expected = hashSignedClaim(init.programTag, in.senderAddress, msg.cumulativeTotal, msg.validUntil);
            assert (isSignatureValid(expected, msg.signature as slice, storage.signerPubkey)) throw 712; // voucher_bad_signature
            // R2-M2: no signature, however valid, pays one wallet past the instance's
            // per-wallet cap. Thrown here, before the receipt is ever messaged, so a
            // refused claim moves no mark and no PRIMES.
            assert (msg.cumulativeTotal <= init.maxPerWallet) throw 716; // voucher_total_above_cap

            // The claimant pays every hop, including the receipt's first deploy and
            // its storage reserve. Checked here, before the mark is known: a
            // replay now costs a round trip to the receipt, which refunds it.
            assert (in.valueCoins >= CLAIM_MIN_VALUE) throw 103; // insufficient_value

            // THE REPLAY RULE lives on the receipt (D-191 point 2): it pays
            // `cumulativeTotal - mark` and stores the total, so a stale or
            // duplicate voucher is a quiet no-op there, not an error here.
            createMessage({
                bounce: BounceMode.NoBounce,
                value: 0,
                dest: receiptStateInit(storage.receiptCode, in.senderAddress),
                body: (ReceiptAdvance { queryId: msg.queryId, cumulativeTotal: msg.cumulativeTotal }).toCell(),
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        ReceiptDelta => {
            // Only the claimant's own receipt, found by derivation, can ask for a
            // payout — and it only does so after a signed claim moved its mark.
            assert (in.senderAddress == receiptAddress(storage.receiptCode, msg.claimant)) throw 100; // wrong_sender
            storage.paidTotal += msg.delta;
            storage.claimCount += 1;
            storage.save();

            // The vault decides whether this program may pay at all and whether
            // the budget covers it. If it refuses, this message bounces and the
            // receipt's mark is rolled back by the bounce handler.
            createMessage({
                bounce: BounceMode.RichBounce,
                value: 0,
                dest: storage.vaultAddr,
                body: (PayProgramBounty {
                    queryId: msg.queryId,
                    programTag: storage.init.load().programTag,
                    beneficiary: msg.claimant,
                    amount: msg.delta,
                }).toCell(),
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        BurnSigner => {
            assert (storage.burnedAt == 0) throw 713; // voucher_already_burned
            // The grace floor. This is the whole of "ends the program without
            // stranding anyone's earned balance", and it is an assert so that
            // the promise is checkable rather than editorial.
            assert (msg.claimDeadline >= blockchain.now() + BURN_MIN_GRACE) throw 714; // voucher_grace_too_short
            assert (isSignatureValid(hashSignedBurn(storage.init.load().programTag, msg.claimDeadline), msg.signature as slice, storage.signerPubkey))
                throw 712; // voucher_bad_signature

            storage.burnedAt = blockchain.now();
            storage.claimDeadline = msg.claimDeadline;
            storage.save();
        }

        else => {
            assert (in.body.isEmpty()) throw 101; // wrong_opcode
        }
    }
}

fun onBouncedMessage(in: InMessageBounced) {
    // The vault refused (not allow-listed, or the program budget is exhausted).
    // The PRIMES never moved, so the receipt's high-water mark must come back down or the
    // claimant is charged for a payment they never received — which would be the
    // one failure mode that turns "replaying pays zero" into "the first attempt
    // pays zero, forever".
    //
    // `beneficiary` and `amount` are both recoverable from the bounced body,
    // which is why RichBounce is used: it is the only way this rollback can name
    // the right wallet.
    var storage = lazy Storage.load();
    val rich = lazy RichBounceBody.fromSlice(in.bouncedBody);
    var body = rich.originalBody.beginParse();
    val opcode = body.loadUint(32);
    if (opcode != 0x90000002) { return; }
    body.loadUint(64);  // queryId
    body.loadUint(32);  // programTag
    val beneficiary = body.loadAddress();
    val amount = body.loadCoins();

    storage.paidTotal = storage.paidTotal > amount ? storage.paidTotal - amount : 0 as coins;
    if (storage.claimCount > 0) { storage.claimCount -= 1; }
    storage.save();

    // The mark lives on the receipt now; take the refused amount back off it.
    // Subtracting, not resetting, keeps two claims in flight honest.
    createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest: receiptAddress(storage.receiptCode, beneficiary),
        body: (ReceiptRestore { queryId: 0, amount: amount }).toCell(),
    }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
}

// ---------------------------------------------------------------------------
// Get-methods (§9.1: every number on `/earn`'s claims panel resolves here)
// ---------------------------------------------------------------------------

// The claimant-facing figure is the RECEIPT's `getPaid()` (D-191 point 2); this
// names where it lives. The receipt may not be deployed yet: an uninitialised
// account at this address means nothing was ever paid.
get fun getReceiptAddress(wallet: address): address {
    val storage = lazy Storage.load();
    return receiptAddress(storage.receiptCode, wallet);
}

// (paidTotal, claimCount) — the program's movement counters, in the same shape
// as the vault's `getVaultPayouts`, so the two are directly reconcilable: this
// contract's `paidTotal` must equal the vault's allow-list spend on this tag.
get fun getProgramPayouts(): (int, int) {
    val storage = lazy Storage.load();
    return (storage.paidTotal, storage.claimCount);
}

// (signerPubkey, burnedAt, claimDeadline, minGrace, programTag). The public key
// is exposed so that a voucher can be verified OFF-CHAIN by its holder before
// they spend gas on it, and so that "the key that signs is the key baked in at
// deploy" is checkable by inspection rather than trusted.
get fun getSignerState(): (int, int, int, int, int) {
    val storage = lazy Storage.load();
    return (storage.signerPubkey, storage.burnedAt, storage.claimDeadline,
            BURN_MIN_GRACE, storage.init.load().programTag);
}

// R2-M2: the most this instance will ever pay one wallet (nano-PRIMES), deploy data.
// A separate getter so `getSignerState`'s positional shape stays what readers parse.
get fun getMaxPerWallet(): int {
    val storage = lazy Storage.load();
    return storage.init.load().maxPerWallet;
}

// True iff a claim sent right now would be refused for being out of time. The
// `/earn` claims panel must state this BEFORE the user pays gas to find out.
get fun isProgramClosed(): int {
    val storage = lazy Storage.load();
    if (storage.claimDeadline == 0) { return 0; }
    return blockchain.now() > storage.claimDeadline ? 1 : 0;
}

// (vaultAddr, vaultSet). Both, so "this program pays out of the vault the
// allow-list names, and that wiring is closed" is checkable by inspection.
get fun getVault(): (address, int) {
    val storage = lazy Storage.load();
    return (storage.vaultAddr, storage.vaultSet);
}
