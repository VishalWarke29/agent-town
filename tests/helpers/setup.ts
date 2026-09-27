/**
 * Vitest setupFiles entry (vitest.config.ts). It runs before every unit test file and installs ONE guard: outbound network
 * access to anything but loopback is refused, and a test that made such an attempt fails in afterEach even if the code
 * under test caught and swallowed the error. Nothing else is global: the model, tool-launch, session-read and
 * real-profile helpers are opt-in, because a flow that legitimately starts git or reads a fixture must keep working.
 *
 * A test that expects a refusal calls noNetwork() itself and take()s the attempt (see tests/unit/test-helpers.test.ts).
 * Limits are the ones in ./index.ts: this sees the test process only.
 *
 * The two hooks below are the whole job of "fail a swallowed call". They are proved by tests/unit/test-helpers.test.ts, which
 * runs real fixture specs through a child vitest process with this file as its setup file (tests/helpers/fixtures/): delete
 * either hook and that test fails. assertNoRefused() itself is unit-tested in the same file.
 */
import { afterAll, afterEach } from 'vitest';
import { assertNoRefused, noNetwork, type NoNetwork } from './no-network';

const GLOBAL_GUARD = Symbol.for('agent-town.tests.globalNetworkGuard');
const holder = globalThis as unknown as Record<symbol, NoNetwork | undefined>;
const guard = (holder[GLOBAL_GUARD] ??= noNetwork());

afterEach(() => assertNoRefused(guard, 'during or just before this test'));
afterAll(() => assertNoRefused(guard, 'outside any test'));
