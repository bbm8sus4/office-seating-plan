// KV-sync optimistic-lock — integration test cases (Slice A + Slice B).
// See kvsync-harness.mjs for the sandbox contract. Run: node functions/test/kvsync.test.mjs
import { extractClientScript, makeDevice, makeServer, test, eq, ok, drain, results } from './kvsync-harness.mjs';

const SRC = extractClientScript();

// Build a device that is booted, sync-ready, and holds an inactive "easyslip" org store with one linked node.
// orgCompany stays "thunder" (active), so "easyslip" is the INACTIVE store the leak-fix targets.
function freshDevice(name, server, ctrl) {
  const d = makeDevice(name, SRC, server, ctrl);
  d.run(`
    _sharedOn = true; _sharedReady = true; _applyingShared = false; _sharedConflict = null;
    _sharedVer = 0; _sharedEditGen = 0;
    if (_sharedPushT) { clearTimeout(_sharedPushT); _sharedPushT = null; }
    // seed a real person in the directory and an inactive-org node linked to them
    state.people = state.people || [];
    if (!state.people.some(p => p.id === 'P1')) state.people.push({ id:'P1', nickname:'Alice', fullName:'Alice A', seat:null });
    // easyslip inactive store: take its seed, link the first node to P1, persist directly (bypassing the fix) as the baseline
    (function(){
      var def = ORG_DEFS['easyslip'];
      var obj = { version:1, nodes: JSON.parse(JSON.stringify(def.seed)) };
      obj.nodes[0].personId = 'P1';
      localStorage.setItem(def.key, JSON.stringify(obj));
    })();
  `);
  return d;
}

const ESKEY = 'osp.org.easyslip.v1';

// ============================== SLICE A — inactive-org persistence + debounce ==============================

test('A1: _unlinkPersonFromAllOrg on inactive store → debounced single POST carrying the updated easyslip key', async () => {
  const server = makeServer(); const ctrl = { failNext: false };
  const d = freshDevice('A1', server, ctrl);
  // sanity: baseline node is linked to P1
  eq(d.run(`JSON.parse(localStorage.getItem('${ESKEY}')).nodes[0].personId`), 'P1', 'baseline link');
  eq(server.posts.length, 0, 'no posts before action');
  d.run(`_unlinkPersonFromAllOrg('P1')`);
  // storage mutated synchronously; push is debounced → NOT sent yet
  eq(d.run(`JSON.parse(localStorage.getItem('${ESKEY}')).nodes[0].personId`), undefined, 'link stripped in storage');
  eq(server.posts.length, 0, 'push still debounced (no POST yet)');
  ok(d.run('_sharedPushT !== null'), 'a debounce timer is armed');
  d.timers.flush(); await drain();
  eq(server.posts.length, 1, 'exactly one POST after debounce fires');
  eq(server.ver, 1, 'server version incremented once');
  // the POSTed bundle carries the mutated easyslip store
  eq(server.data.orgs[ESKEY].nodes[0].personId, undefined, 'POST body has stripped link');
});

test('A2: TWO real inactive-org writes within 700ms → editGen +2 but ONE POST, version +1 only', async () => {
  const server = makeServer(); const ctrl = { failNext: false };
  const d = freshDevice('A2', server, ctrl);
  // add a second person + a second linked node so we can produce TWO genuinely-mutating inactive writes
  d.run(`
    state.people.push({id:'P2', nickname:'Bea', fullName:'Bea B', seat:null});
    (function(){ var k='${ESKEY}'; var o=JSON.parse(localStorage.getItem(k)); o.nodes[1].personId='P2'; localStorage.setItem(k,JSON.stringify(o)); })();
  `);
  const genBefore = d.run('_sharedEditGen');
  // two distinct inactive-org actions back-to-back, both mutate storage + schedule a push, before any timer fires:
  d.run(`_unlinkPersonFromAllOrg('P1');`); // strips P1 from node 0
  d.run(`_unlinkPersonFromAllOrg('P2');`); // strips P2 from node 1 (a second real write, not a no-op)
  eq(d.run('_sharedEditGen') - genBefore, 2, 'both writes bumped the edit generation (two real schedules)');
  eq(d.run(`JSON.parse(localStorage.getItem('${ESKEY}')).nodes[0].personId`), undefined, 'node0 unlinked');
  eq(d.run(`JSON.parse(localStorage.getItem('${ESKEY}')).nodes[1].personId`), undefined, 'node1 unlinked');
  eq(server.posts.length, 0, 'no POST before debounce');
  d.timers.flush(); await drain();
  eq(server.posts.length, 1, 'the two writes collapsed into a single POST (debounce)');
  eq(server.ver, 1, 'version advanced only once');
});

test('A2b: repairOrgPersonLinks writes an inactive store when it finds a ghost link → schedules a push', async () => {
  const server = makeServer(); const ctrl = { failNext: false };
  const d = freshDevice('A2b', server, ctrl);
  // create a genuine ghost: an inactive-org node linked to a person that is NOT in the directory
  d.run(`(function(){ var k='${ESKEY}'; var o=JSON.parse(localStorage.getItem(k)); o.nodes[0].personId='GHOST-not-in-directory'; localStorage.setItem(k,JSON.stringify(o)); })();`);
  d.run(`repairOrgPersonLinks();`); // must detect the ghost in the inactive store and persist via the helper
  eq(d.run(`JSON.parse(localStorage.getItem('${ESKEY}')).nodes[0].personId`), undefined, 'ghost link stripped in inactive store');
  ok(d.run('_sharedPushT !== null'), 'repair scheduled a push after mutating the inactive store');
  d.timers.flush(); await drain();
  eq(server.posts.length, 1, 'exactly one POST');
  eq(server.data.orgs[ESKEY].nodes[0].personId, undefined, 'POST body carries the repaired store');
});

test('A2c: confirmLinkOrg non-active branch → writes inactive store + schedules push with the new link', async () => {
  const server = makeServer(); const ctrl = { failNext: false };
  const d = freshDevice('A2c', server, ctrl);
  // start from a clean easyslip store (no links), then link P1 to node 0 via the real UI path
  d.run(`(function(){ var def=ORG_DEFS['easyslip']; localStorage.setItem(def.key, JSON.stringify({version:1,nodes:JSON.parse(JSON.stringify(def.seed))})); })();`);
  const targetNode = d.run(`ORG_DEFS['easyslip'].seed[0].id`);
  d.run(`openLinkOrgModal('P1');`); // sets linkingPersonId = P1
  d.setInput('linkOrgCompany', 'easyslip');  // non-active (active is thunder)
  d.setInput('linkOrgNode', targetNode);
  d.run(`confirmLinkOrg();`);
  eq(d.run(`JSON.parse(localStorage.getItem('${ESKEY}')).nodes.find(n=>n.id===${JSON.stringify(targetNode)}).personId`), 'P1', 'link persisted to inactive store via confirmLinkOrg');
  ok(d.run('_sharedPushT !== null'), 'confirmLinkOrg non-active scheduled a push');
  d.timers.flush(); await drain();
  eq(server.posts.length, 1, 'one POST');
  eq(server.data.orgs[ESKEY].nodes.find(n => n.id === targetNode).personId, 'P1', 'POST body carries the new link');
});

test('A2d: unlinkPersonFromOrg non-active branch → writes inactive store + schedules push', async () => {
  const server = makeServer(); const ctrl = { failNext: false };
  const d = freshDevice('A2d', server, ctrl); // baseline already links node0 → P1 in easyslip
  const node0 = d.run(`JSON.parse(localStorage.getItem('${ESKEY}')).nodes[0].id`);
  d.run(`unlinkPersonFromOrg('P1','easyslip',${JSON.stringify(node0)});`); // non-active branch (active=thunder)
  eq(d.run(`JSON.parse(localStorage.getItem('${ESKEY}')).nodes[0].personId`), undefined, 'unlinked in inactive store');
  ok(d.run('_sharedPushT !== null'), 'unlinkPersonFromOrg non-active scheduled a push');
  d.timers.flush(); await drain();
  eq(server.posts.length, 1, 'one POST');
  eq(server.data.orgs[ESKEY].nodes[0].personId, undefined, 'POST body carries the unlink');
});

test('A3: inactive-org write failure (quota) → 0 POST (nothing scheduled on failed write)', async () => {
  const server = makeServer(); const ctrl = { failNext: false };
  const d = freshDevice('A3', server, ctrl);
  // force setItem to throw a quota error for the easyslip key only
  d.run(`
    _saveInactiveOrgFailed = false;
    var _origSet = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function(k,v){ if(k==='${ESKEY}'){ var e=new Error('quota'); e.name='QuotaExceededError'; throw e; } return _origSet(k,v); };
    // call helper directly with a valid obj → write throws → helper returns false → no schedule
    var def = ORG_DEFS['easyslip'];
    var obj = { version:1, nodes: JSON.parse(JSON.stringify(def.seed)) };
    _saveInactiveOrgResult = _saveInactiveOrg('easyslip', obj);
    localStorage.setItem = _origSet;
  `);
  eq(d.run('_saveInactiveOrgResult'), false, 'helper returns false on write failure');
  eq(d.run('_sharedPushT'), null, 'no debounce timer armed after failed write');
  d.timers.flush(); await drain();
  eq(server.posts.length, 0, 'no POST after a failed inactive-org write');
});

test('A4: active-org path (saveOrg) still pushes exactly once, not doubled', async () => {
  const server = makeServer(); const ctrl = { failNext: false };
  const d = freshDevice('A4', server, ctrl);
  d.run(`
    // mutate the ACTIVE org (thunder) and save through the normal active path
    orgState.nodes[0].name = 'renamed-by-test';
    saveOrg();
  `);
  eq(server.posts.length, 0, 'active save is also debounced (no immediate POST)');
  d.timers.flush(); await drain();
  eq(server.posts.length, 1, 'active path pushes exactly once (no duplicate)');
  eq(server.ver, 1, 'version +1 only');
});

// ============================== SLICE B — async conflict ordering ==============================

// Drive one device to a pending-conflict state by racing a second device's write in between.
// Returns after device `d` holds _sharedConflict from a real 409.
async function driveToConflict(d, other, server) {
  // both start synced at ver 0; give the shared store an initial value from `other`
  other.run(`_sharedVer = 0;`);
  d.run(`_sharedVer = 0;`);
  // `other` commits first → server ver becomes 1, but `d` still thinks baseVer 0
  other.run(`state.people = state.people || []; state.people.push({id:'PB', nickname:'Bob', seat:null}); _scheduleSharedPush();`);
  other.timers.flush(); await drain();
  eq(server.ver, 1, 'other committed first');
  // now `d` edits and pushes with stale baseVer 0 → 409 → conflict
  d.run(`state.people.push({id:'PC', nickname:'Carol', seat:null}); _scheduleSharedPush();`);
  d.timers.flush(); await drain();
  ok(d.run('_sharedConflict !== null'), 'device landed in a real 409 conflict');
}

test('B1: 409 → local edit while conflict pending → conflict.local reflects the LATEST snapshot', async () => {
  const server = makeServer(); const ctrl = { failNext: false };
  const A = freshDevice('B1a', server, ctrl); const B = freshDevice('B1b', server, ctrl);
  await driveToConflict(A, B, server);
  const genBefore = A.run('_sharedEditGen');
  // user keeps editing on A while the banner is up
  A.run(`state.people.push({id:'PD', nickname:'Dave', seat:null}); _scheduleSharedPush();`);
  ok(A.run('_sharedEditGen') > genBefore, 'edit generation bumped');
  eq(server.posts.length, 2, 'no extra POST while conflict pending (only the 2 that caused/exposed it)');
  // conflict.local must now include Dave (refreshed snapshot), not the stale one captured at 409
  ok(A.run(`_sharedConflict.local.state.people.some(p=>p.id==='PD')`), 'conflict.local refreshed to latest edit');
});

test('B2: edit AFTER 409 → keep-mine asserts the LATEST local bundle (not the stale 409 snapshot)', async () => {
  const server = makeServer(); const ctrl = { failNext: false };
  const A = freshDevice('B2a', server, ctrl); const B = freshDevice('B2b', server, ctrl);
  await driveToConflict(A, B, server); // A's conflict.local snapshot was captured with Carol only
  // user keeps editing on A AFTER the conflict banner shows (adds Dave) — _scheduleSharedPush refreshes conflict.local
  A.run(`state.people.push({id:'PD', nickname:'Dave', seat:null}); _scheduleSharedPush();`);
  A.run(`_resolveConflictKeepMine()`); await drain();
  eq(A.run('_sharedConflict'), null, 'conflict cleared after keep-mine');
  // server must hold BOTH the pre-409 edit (Carol) AND the post-409 edit (Dave) — the refresh worked end-to-end
  ok(server.data.state.people.some(p => p.id === 'PC'), 'server holds pre-409 edit (Carol)');
  ok(server.data.state.people.some(p => p.id === 'PD'), 'server holds the post-409 edit (Dave) — latest bundle asserted');
});

test('B3: edit DURING keep-mine in-flight → first assert succeeds + deferred push, the extra edit is not lost', async () => {
  const server = makeServer(); const ctrl = { failNext: false };
  const A = freshDevice('B3a', server, ctrl); const B = freshDevice('B3b', server, ctrl);
  await driveToConflict(A, B, server);
  const postsAtStart = server.posts.length;
  // start keep-mine but inject an edit before the fetch .then settles
  A.run(`_resolveConflictKeepMine()`);
  A.run(`state.people.push({id:'PE', nickname:'Eve', seat:null}); _scheduleSharedPush();`); // lands while request in-flight
  await drain(); // keep-mine resolves → detects gen change → deferred _sharedPushNow()
  await drain(); // deferred push settles
  eq(A.run('_sharedConflict'), null, 'conflict cleared');
  ok(server.posts.length >= postsAtStart + 2, 'a follow-up deferred POST was sent');
  // final server state must contain the edit that landed mid-flight
  ok(server.data.state.people.some(p => p.id === 'PE'), 'the mid-flight edit reached the server (not dropped)');
});

test('B4: keep-mine re-assert hits a fresh 409 (someone edited again) → conflict re-opened, no silent overwrite', async () => {
  const server = makeServer(); const ctrl = { failNext: false };
  const A = freshDevice('B4a', server, ctrl); const B = freshDevice('B4b', server, ctrl);
  await driveToConflict(A, B, server); // A holds conflict at baseVer=1, server.ver=1
  // B commits AGAIN before A's keep-mine goes through → A's re-assert (baseVer=1) now hits server.ver=2 → 409.
  // This is the real "someone edited while I was re-asserting" guard: it must refresh the conflict + keep the
  // banner (server bundle updated), never let mine silently overwrite the newer server state.
  B.run(`_sharedVer = ${server.ver}; state.people.push({id:'PF', nickname:'Frank', seat:null}); _scheduleSharedPush();`);
  B.timers.flush(); await drain();
  eq(server.ver, 2, 'B advanced the server before A re-asserts');
  A.run(`_resolveConflictKeepMine()`); await drain();
  ok(A.run('_sharedConflict !== null'), 're-assert 409 re-opened the conflict (no silent overwrite)');
  eq(A.run('_sharedConflict.ver'), 2, 'conflict refreshed to the newer server version');
  ok(A.run(`_sharedConflict.server.state.people.some(p=>p.id==='PF')`), 'conflict.server now shows the newer team bundle (Frank)');
  ok(!server.data.state.people.some(p => p.id === 'PC'), 'mine (Carol) did NOT overwrite the server on the 409');
});

test('B4b: DIRECT deferred-push 409 → the follow-up push (edit landed mid-keep-mine) hits a fresh 409, conflict re-opens, mine not overwritten', async () => {
  const server = makeServer(); const ctrl = { failNext: false };
  const A = freshDevice('B4ba', server, ctrl); const B = freshDevice('B4bb', server, ctrl);
  await driveToConflict(A, B, server); // A conflict at ver 1; A.state has Carol (PC)
  // Arm a one-shot: when A's DEFERRED push goes out (baseVer === 2, i.e. after the keep-mine initial assert
  // bumped the server to 2), let B commit first so the deferred POST is evaluated against a newer server → 409.
  ctrl.beforePost = (body) => {
    if ((body.baseVer | 0) !== 2) return false;
    ctrl.beforePost = null; // disarm FIRST — B's own POST below shares this ctrl and must not re-enter the hook
    // bump the server directly (not via B's _sharedPushNow, which would issue a nested fetch mid-A-fetch):
    server.ver += 1; server.data = { state: { people: [{ id: 'PF', nickname: 'Frank' }] } };
    return true;
  };
  A.run(`_resolveConflictKeepMine()`);
  A.run(`state.people.push({id:'PE', nickname:'Eve', seat:null}); _scheduleSharedPush();`); // mid-flight edit → triggers deferred push on keep-mine success
  await drain(); await drain(); await drain();
  ok(A.run('_sharedConflict !== null'), 'deferred-push 409 re-opened the conflict');
  // the deferred push must NOT have overwritten the server — Frank (B) survives, and the conflict.server shows it
  ok(server.data.state.people.some(p => p.id === 'PF'), 'server still holds B\'s newer commit (Frank) — no silent overwrite');
  ok(A.run(`_sharedConflict.local.state.people.some(p=>p.id==='PE')`), 'conflict.local carries the mid-flight edit (Eve) — not lost, available to re-resolve');
});

test('B5: use-theirs (adopt succeeds) → server bundle adopted, no deferred re-push', async () => {
  const server = makeServer(); const ctrl = { failNext: false };
  const A = freshDevice('B5a', server, ctrl); const B = freshDevice('B5b', server, ctrl);
  await driveToConflict(A, B, server);
  const postsBefore = server.posts.length;
  A.run(`_resolveConflictUseTheirs()`); await drain();
  eq(A.run('_sharedConflict'), null, 'conflict cleared on successful adopt');
  // adopted server bundle → A's state now contains Bob (from B), not just Carol
  ok(A.run(`state.people.some(p=>p.id==='PB')`), 'A adopted the team bundle (Bob present)');
  await drain();
  eq(server.posts.length, postsBefore, 'use-theirs performs ZERO push');
});

test('B6 ⭐ (P1): use-theirs where adopt FAILS → local byte-identical + conflict still up + 0 push', async () => {
  const server = makeServer(); const ctrl = { failNext: false };
  const A = freshDevice('B6a', server, ctrl); const B = freshDevice('B6b', server, ctrl);
  await driveToConflict(A, B, server);
  // corrupt the server-side bundle in the pending conflict so _applyShared() rejects it
  A.run(`_sharedConflict.server = { state: { people: 'not-an-array-invalid' } };`);
  const localBefore = A.run(`JSON.stringify(state.people)`);
  const postsBefore = server.posts.length;
  const conflictLocalBefore = A.run(`JSON.stringify(_sharedConflict.local)`);
  A.run(`_resolveConflictUseTheirs()`); await drain();
  ok(A.run('_sharedConflict !== null'), 'conflict STAYS up when adopt fails (no silent clear)');
  eq(A.run(`JSON.stringify(state.people)`), localBefore, 'local state byte-identical (mine untouched)');
  eq(A.run(`JSON.stringify(_sharedConflict.local)`), conflictLocalBefore, 'conflict.local preserved for retry');
  // and crucially: no push slipped out
  A.timers.flush(); await drain();
  eq(server.posts.length, postsBefore, 'ZERO push after failed adopt (P1 data-loss window closed)');
});

test('B7: network failure during keep-mine → conflict + latest mine survive for retry', async () => {
  const server = makeServer(); const ctrl = { failNext: false };
  const A = freshDevice('B7a', server, ctrl); const B = freshDevice('B7b', server, ctrl);
  await driveToConflict(A, B, server);
  const mineBefore = A.run(`JSON.stringify(_sharedConflict.local)`);
  ctrl.failNext = true; // the keep-mine POST will reject
  A.run(`_resolveConflictKeepMine()`); await drain();
  ok(A.run('_sharedConflict !== null'), 'conflict retained after network failure');
  eq(A.run(`JSON.stringify(_sharedConflict.local)`), mineBefore, 'latest mine preserved for retry');
});

test('B8: polling/focus pull while a conflict is pending → does NOT auto-adopt server', async () => {
  const server = makeServer(); const ctrl = { failNext: false };
  const A = freshDevice('B8a', server, ctrl); const B = freshDevice('B8b', server, ctrl);
  await driveToConflict(A, B, server);
  const localBefore = A.run(`JSON.stringify(state.people)`);
  A.run(`pullShared(true)`); await drain(); // simulates the 10s poll / focus handler
  ok(A.run('_sharedConflict !== null'), 'conflict still pending after a poll');
  eq(A.run(`JSON.stringify(state.people)`), localBefore, 'poll did not silently adopt server behind the banner');
});

// ============================== runner ==============================
(async () => {
  let pass = 0, fail = 0;
  for (const t of results) {
    try { await t.fn(); console.log(`  \x1b[32mPASS\x1b[0m ${t.name}`); pass++; }
    catch (e) { console.log(`  \x1b[31mFAIL\x1b[0m ${t.name}\n        ${e.message}`); fail++; }
  }
  console.log(`\n${pass}/${pass + fail} passed` + (fail ? `, \x1b[31m${fail} FAILED\x1b[0m` : ''));
  process.exit(fail ? 1 : 0);
})();
