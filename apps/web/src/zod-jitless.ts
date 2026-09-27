// Zod's global fast path compiles a schema-specific validator with `new Function` the first time any
// schema is parsed. Under a strict CSP with no `unsafe-eval`, the attempt still throws and is caught,
// so parsing keeps working, but Chrome reports the caught throw as a `securitypolicyviolation` anyway
// (SP-4: one such event on every page load). `z.config({ jitless: true })` makes zod skip that probe
// and always use its runtime parser instead — no eval attempt, so no violation. This file has no
// purpose beyond that one call and must run before anything else imports zod (contracts, and anything
// that validates with it), which is why main.tsx imports it first and nothing here imports react or
// app code. This never asks for `unsafe-eval`; the CSP header itself is unchanged.
import { z } from 'zod';

z.config({ jitless: true });
