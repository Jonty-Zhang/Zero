import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// Windows runners may expose TEMP through an 8.3 alias. Fixtures must use the
// same canonical directory identity as production's strict realpath checks.
// This affects only this test process and its children, never machine settings.
const canonicalTemporaryDirectory = await realpath(tmpdir());
process.env.TEMP = canonicalTemporaryDirectory;
process.env.TMP = canonicalTemporaryDirectory;
process.env.TMPDIR = canonicalTemporaryDirectory;
